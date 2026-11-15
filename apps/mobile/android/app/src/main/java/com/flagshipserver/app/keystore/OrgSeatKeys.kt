package com.flagshipserver.app.keystore

import android.content.Context
import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.core.pq.PqTrust
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.SecureRandom

/** One org seat this phone holds (Kotlin twin of iOS `OrgSeatKeys.Seat`). */
data class OrgSeatRecord(
    val orgId: String,
    val seatId: String,
    val orgName: String,
    val genesisHash: String,
    val binding: PqTrust.Wire,
    /** A member seat holds no admin key: [binding] is its member key's, and it approves nothing. */
    val memberOnly: Boolean,
) {
    val keyId: String get() = OrgAuthority.keyIdHex(binding.ed25519PubHex, binding.mldsaPubHex)
    val id: String get() = "$orgId:$seatId"
}

/** The seats on this phone and their admin keys. Production: [KeystoreOrgSeatKeys]; tests use a fake. */
interface OrgSeatStore {
    fun seats(): List<OrgSeatRecord>
    /** A random hybrid seat admin key and its `org-seat-admin` binding; nothing is kept until [remember]. */
    fun makeKey(orgId: String, seatId: String, now: Long): Pair<PqTrust.Wire, ByteArray>
    fun remember(orgId: String, seatId: String, orgName: String, genesisHash: String, binding: PqTrust.Wire, secret: ByteArray)
    fun rememberMember(orgId: String, seatId: String, orgName: String, genesisHash: String, memberBinding: PqTrust.Wire)
    /** Signs with the seat admin key; null when the session is locked (the caller asks to unlock). */
    fun sign(seat: OrgSeatRecord, purpose: String, payload: ByteArray): ByteArray?
}

/**
 * A seat admin key is RANDOM (never UMK-derived: the person's non-admin devices hold the UMK),
 * hybrid Ed25519 + ML-DSA-65, made here; both 32-byte seeds are wrapped by the PQ seed wrapper
 * ("PQ, hardware-wrapped": the Keystore key or the unlocked session's KEK) and opened for one
 * signature at a time.
 */
class KeystoreOrgSeatKeys(
    private val persistence: PqKeyStore.Persistence,
    private val wrapper: PqSeedWrapper,
    private val rng: SecureRandom = SecureRandom(),
) : OrgSeatStore {
    constructor(context: Context) : this(
        OrgSeatPrefs(context),
        SessionKekPqSeedWrapper(KeystorePqSeedWrapper()),
    )

    @Serializable
    private data class Stored(
        val orgId: String, val seatId: String, val orgName: String, val genesisHash: String,
        val binding: String, val memberOnly: Boolean, val edWrappedHex: String = "", val mlWrappedHex: String = "",
    )

    private val json = Json { ignoreUnknownKeys = true }
    private fun slot(orgId: String, seatId: String) = "org-seat.$orgId.$seatId"

    private fun decode(s: Stored): OrgSeatRecord? = runCatching {
        OrgSeatRecord(s.orgId, s.seatId, s.orgName, s.genesisHash, PqTrust.pqKeyBindingFromWire(Json.parseToJsonElement(s.binding)), s.memberOnly)
    }.getOrNull()

    override fun seats(): List<OrgSeatRecord> = persistence.keys().filter { it.startsWith("org-seat.") }.mapNotNull { k ->
        persistence.load(k)?.let { runCatching { json.decodeFromString(Stored.serializer(), it) }.getOrNull() }?.let(::decode)
    }.sortedBy { it.orgName }

    override fun makeKey(orgId: String, seatId: String, now: Long): Pair<PqTrust.Wire, ByteArray> {
        val ed = ByteArray(32).also(rng::nextBytes)
        val ml = ByteArray(32).also(rng::nextBytes)
        val kp = PqHybrid.hybridSigKeygen(ed, ml)
        val st = PqTrust.Statement("org-seat-admin", OrgAuthority.seatSubject(orgId, seatId), PqHex.encode(kp.publicKey.copyOfRange(0, 32)),
            PqHex.encode(kp.publicKey.copyOfRange(32, kp.publicKey.size)), now)
        return PqTrust.signPqKeyBinding(st) { m -> PqHybrid.hybridSign(kp.secretKey, PqTrust.TAG_PQ_KEY_BINDING, m) } to kp.secretKey
    }

    override fun remember(orgId: String, seatId: String, orgName: String, genesisHash: String, binding: PqTrust.Wire, secret: ByteArray) {
        require(secret.size == 64)
        val ed = secret.copyOfRange(0, 32); val ml = secret.copyOfRange(32, 64)
        try {
            val s = Stored(orgId, seatId, orgName, genesisHash, binding.toJson().toString(), false,
                PqHex.encode(wrapper.wrap(ed)), PqHex.encode(wrapper.wrap(ml)))
            persistence.save(slot(orgId, seatId), json.encodeToString(Stored.serializer(), s))
        } finally { ed.fill(0); ml.fill(0) }
    }

    override fun rememberMember(orgId: String, seatId: String, orgName: String, genesisHash: String, memberBinding: PqTrust.Wire) {
        val s = Stored(orgId, seatId, orgName, genesisHash, memberBinding.toJson().toString(), true)
        persistence.save(slot(orgId, seatId), json.encodeToString(Stored.serializer(), s))
    }

    override fun sign(seat: OrgSeatRecord, purpose: String, payload: ByteArray): ByteArray? {
        if (seat.memberOnly) return null
        val s = persistence.load(slot(seat.orgId, seat.seatId))?.let { runCatching { json.decodeFromString(Stored.serializer(), it) }.getOrNull() } ?: return null
        val ed = runCatching { wrapper.unwrap(PqHex.decode(s.edWrappedHex)!!) }.getOrNull() ?: return null
        val ml = runCatching { wrapper.unwrap(PqHex.decode(s.mlWrappedHex)!!) }.getOrNull() ?: run { ed.fill(0); return null }
        val secret = ed + ml
        try {
            return PqHybrid.hybridSign(secret, purpose, payload)
        } finally { ed.fill(0); ml.fill(0); secret.fill(0) }
    }
}

class OrgSeatPrefs(context: Context) : PqKeyStore.Persistence {
    private val prefs = context.getSharedPreferences("flagship.orgseats.v1", Context.MODE_PRIVATE)
    override fun load(key: String): String? = prefs.getString(key, null)
    override fun save(key: String, value: String) { prefs.edit().putString(key, value).apply() }
    override fun remove(key: String) { prefs.edit().remove(key).apply() }
    override fun keys(): Set<String> = prefs.all.keys
}
