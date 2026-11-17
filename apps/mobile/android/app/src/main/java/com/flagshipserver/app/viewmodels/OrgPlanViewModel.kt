package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.R
import com.flagshipserver.app.api.PaymentsClient
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.OrgClient
import com.flagshipserver.app.core.OrgSnapshot
import com.flagshipserver.app.core.memberKey
import com.flagshipserver.app.core.payments.OrgPaymentsCenter
import com.flagshipserver.app.core.payments.OrgPaymentsLocal
import com.flagshipserver.app.core.payments.OrgPlanBackend
import com.flagshipserver.app.core.payments.OrgPlanServed
import com.flagshipserver.app.core.payments.OrgWalletKeyring
import com.flagshipserver.app.core.payments.OrgWalletPut
import com.flagshipserver.app.core.payments.OrgWalletRing
import com.flagshipserver.app.core.payments.PaymentsCenter
import com.flagshipserver.app.core.payments.PaymentsUi
import com.flagshipserver.app.core.payments.VoucherShop
import com.flagshipserver.app.core.pq.OrgAdminKind
import com.flagshipserver.app.core.pq.OrgApproval
import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.OrgAuthorityException
import com.flagshipserver.app.core.pq.OrgKeyKind
import com.flagshipserver.app.core.pq.OrgRotation
import com.flagshipserver.app.core.pq.OrgServers
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.keystore.OrgSeatRecord
import com.flagshipserver.app.keystore.OrgSeatStore
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** `.com`'s org plan and wallet routes. */
class LiveOrgPlanBackend(private val client: OrgClient) : OrgPlanBackend {
    override suspend fun plan(orgId: String): OrgPlanServed? = client.plan(orgId)
    override suspend fun wallet(orgId: String): JsonObject? = client.voucherWallet(orgId)
    override suspend fun putWallet(orgId: String, blob: JsonObject, write: JsonObject, approval: OrgApproval): OrgWalletPut =
        client.putVoucherWallet(orgId, blob, write, approval)
}

/**
 * The org's `wallet` key on this phone, opened the way the directory key is: from the org's records this phone
 * verifies from its pinned genesis, with the seat's X-Wing key from the UMK. The first org admin to open the Plan makes
 * version 1 (sealed to every org admin with a KEM key), posted to `POST /api/orgs/<id>/keys` like the other rings.
 */
class LiveOrgWalletKeyring(
    private val seat: OrgSeatRecord,
    private val client: OrgClient,
    private val keys: OrgSeatStore,
    /** The UMK behind the unlock prompt (the Plan screen). */
    private val umkPrompt: suspend (reason: String) -> ByteArray,
    /** The UMK only while the session is already open (background work never prompts). */
    private val umkQuiet: () -> ByteArray?,
    private val now: () -> Long = System::currentTimeMillis,
) : OrgWalletKeyring {
    @Volatile private var snapshot: OrgSnapshot? = null

    override fun isAdmin(): Boolean {
        val s = snapshot ?: return !seat.memberOnly
        return s.state.current.admins.any { it.seatId == seat.seatId && it.kind == OrgAdminKind.ADMIN }
    }

    override suspend fun walletRing(interactive: Boolean): OrgWalletRing? {
        val t = now()
        val s = client.snapshot(seat.orgId, seat.genesisHash, t).also { snapshot = it }
        if (!isAdmin()) return null
        val seed = if (interactive) umkPrompt(FSStrings.get(R.string.org_plan_open_reason)) else umkQuiet() ?: return null
        try {
            val kemSeed = OrgServers.seatKemSeed(seed, seat.orgId)
            val kp = try { PqHybrid.hybridSealKeygen(kemSeed) } finally { kemSeed.fill(0) }
            var plan = client.rotationPlan(s, t)
            if (plan.ctx.kems["seat:${seat.seatId}"]?.kemKeyId != OrgServers.kemKeyIdHex(kp.publicKey)) {
                if (!interactive) return null
                publishOrgSeatKem(client, keys, seat, s, seed, t)
                plan = client.rotationPlan(s, now())
            }
            if (plan.chains[OrgRotation.chainId(OrgKeyKind.WALLET, "*")].isNullOrEmpty()) {
                if (!interactive) return null
                val key = ByteArray(32).also(java.security.SecureRandom()::nextBytes)
                val b = try {
                    OrgRotation.rotate(plan, OrgKeyKind.WALLET, "*", now(), key) { order, _ -> approve(order) ?: throw OrgAuthorityException("locked") }
                } finally { key.fill(0) }
                client.postKeyRing(seat.orgId, OrgRotation.bundleJson(b))
                plan = client.rotationPlan(s, now())
            }
            val chain = plan.chains[OrgRotation.chainId(OrgKeyKind.WALLET, "*")].orEmpty()
            val opened = HashMap<Long, ByteArray>()
            for (b in chain) {
                runCatching { OrgServers.openKeyRing(b.ring, b.recipients, "seat:${seat.seatId}", kp.secretKey) }.getOrNull()?.let { opened[b.ring.version] = it }
            }
            return OrgWalletRing(opened, chain.filter { it.ring.retired.isNotEmpty() }.map { it.ring.version }.toSet())
        } finally {
            seed.fill(0)
        }
    }

    override fun approve(order: ByteArray): OrgApproval? {
        val s = snapshot ?: return null
        val t = now()
        return runCatching {
            OrgAuthority.signApproval(seat.orgId, s.state.current.version, order, seat.seatId, seat.keyId, t, t + OrgViewModel.DAY) { p, m ->
                keys.sign(seat, p, m) ?: throw OrgAuthorityException("locked")
            }
        }.getOrNull()
    }
}

/** This seat's X-Wing key from the UMK, signed by the seat's admin key (an org admin) or its member key. */
internal suspend fun publishOrgSeatKem(client: OrgClient, keys: OrgSeatStore, seat: OrgSeatRecord, s: OrgSnapshot, seed: ByteArray, t: Long) {
    val kemSeed = OrgServers.seatKemSeed(seed, seat.orgId)
    val kp = try { PqHybrid.hybridSealKeygen(kemSeed) } finally { kemSeed.fill(0) }
    val kemKeyId = OrgServers.kemKeyIdHex(kp.publicKey)
    val msg = OrgServers.canonicalSeatKem(seat.orgId, seat.seatId, kemKeyId, t)
    val sig = if (s.state.current.admins.any { it.seatId == seat.seatId }) {
        keys.sign(seat, OrgServers.TAG_SEAT_KEM, msg) ?: throw OrgAuthorityException("locked")
    } else {
        val (_, secret) = OrgAuthority.memberKey(seed, seat.orgId, seat.seatId, t)
        try { PqHybrid.hybridSign(secret, OrgServers.TAG_SEAT_KEM, msg) } finally { secret.fill(0) }
    }
    client.postSeatKem(seat.orgId, buildJsonObject {
        put("statement", buildJsonObject { put("orgId", seat.orgId); put("seatId", seat.seatId); put("kemKeyId", kemKeyId); put("issuedAt", t) })
        put("kemPubHex", PqHex.encode(kp.publicKey))
        put("signature", PqHex.encode(sig))
    })
}

/**
 * One OrgPaymentsCenter per org seat on this phone, shared by the Plan screen, the store shop (purchases for an org's
 * wallet) and the foreground trickle (MainActivity.onStart, beside the personal wallet's tick).
 */
object OrgPlanCenters {
    private val centers = HashMap<String, OrgPaymentsCenter>()

    /** Builds a seat's center (set once by the activity; the gym sets a scripted one). */
    @Volatile var factory: ((OrgSeatRecord) -> OrgPaymentsCenter)? = null

    /** The seats the trickle walks (the gym's seats when it scripts them). */
    @Volatile var seats: () -> List<OrgSeatRecord> = { emptyList() }

    @Synchronized
    fun get(seat: OrgSeatRecord): OrgPaymentsCenter? {
        centers[seat.id]?.let { return it }
        val made = factory?.invoke(seat) ?: return null
        centers[seat.id] = made
        return made
    }

    @Synchronized
    fun byOrg(orgId: String): OrgPaymentsCenter? = seats().firstOrNull { it.orgId == orgId && !it.memberOnly }?.let(::get)

    @Synchronized
    fun reset() { centers.clear() }

    /** The live wiring: the org runtime's client and seat keys, the personal center's config, keys and relays. */
    fun installLive(rt: OrgRuntime, payments: PaymentsClient, quietUmk: () -> ByteArray?, local: OrgPaymentsLocal) {
        reset()
        seats = { rt.keys.seats() }
        factory = { seat ->
            OrgPaymentsCenter(
                seat.orgId,
                LiveOrgPlanBackend(rt.client),
                LiveOrgWalletKeyring(seat, rt.client, rt.keys, rt.umk, quietUmk),
                payments,
                shared = { PaymentsCenter.shared?.state?.value ?: PaymentsUi() },
                local = local,
            )
        }
        // Bought vouchers go into the org's wallet, and the trickle looks at once (a lapsed org pays straight away).
        VoucherShop.orgSink = { orgId, vouchers ->
            val c = byOrg(orgId)
            val ok = c?.addVouchers(vouchers) == true
            if (ok) runCatching { c!!.tick() }
            ok
        }
    }

    /** One foreground tick for every org this phone administers (never prompts). */
    suspend fun tickAll() {
        for (seat in seats().filter { !it.memberOnly }) {
            val c = get(seat) ?: continue
            runCatching { c.refresh(interactive = false); c.tick() }
        }
    }
}
