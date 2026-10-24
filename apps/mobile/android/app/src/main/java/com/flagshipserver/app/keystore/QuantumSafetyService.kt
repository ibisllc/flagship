package com.flagshipserver.app.keystore

import android.content.Context
import com.flagshipserver.app.api.PqSignatureWire
import com.flagshipserver.app.core.BoxKeyPins
import com.flagshipserver.app.core.pq.PqChannelInterceptor
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqSession
import com.flagshipserver.app.core.pq.PqTrust
import com.flagshipserver.app.core.pq.QuantumSafety
import com.google.crypto.tink.subtle.Ed25519Sign

/**
 * Architecture v2 milestone 4 on Android (the port of iOS's QuantumSafetyService): which servers
 * this phone holds as strict, the PQ tunnel to them, and the hybrid signature strict servers need
 * on sensitive orders (docs/architecture-v2/pq-suites.md §13).
 */
object QuantumSafetyService {
    @Volatile var store: QuantumSafety.Store? = null
    @Volatile var pqKeys: PqKeyStore? = null
    @Volatile var pins: BoxKeyPins? = null

    fun attach(context: Context, keys: PqKeyStore, boxPins: BoxKeyPins) {
        val prefs = context.getSharedPreferences("flagship.assurance.v1", Context.MODE_PRIVATE)
        store = QuantumSafety.Store(object : QuantumSafety.Persistence {
            override fun load(key: String) = prefs.getString(key, null)
            override fun save(key: String, value: String) { prefs.edit().putString(key, value).apply() }
            override fun keys(): Set<String> = prefs.all.keys
            override fun remove(key: String) { prefs.edit().remove(key).apply() }
        }) { Keystore.activeProfile() }
        pqKeys = keys
        pins = boxPins
    }

    /** Installs the tunnel for the signed-in account (null uninstalls it). */
    fun activate(username: String?, deviceId: String?) {
        val t = PqChannelInterceptor.shared
        t.reset()
        val user = username?.lowercase()
        val dev = deviceId?.lowercase()
        if (user.isNullOrEmpty() || dev.isNullOrEmpty()) {
            t.isStrict = { false }; t.responder = { null }; t.identity = { null }
            return
        }
        t.isStrict = { host -> store?.replayed(user, com.flagshipserver.app.core.pq.AssurancePolicy.Scope("installation", host))?.strict == true }
        t.responder = { host -> pins?.verifiedBoxPqBinding(user, host) }
        t.identity = { deviceIdentity(user, dev) }
    }

    fun forget(username: String?) {
        username?.let { store?.forget(it) }
        activate(null, null)
    }

    fun anyStrict(username: String): Boolean = store?.anyStrict(username) == true

    /** Whether this phone replays the server's installation policy as strict. */
    fun isStrict(username: String, serverDomain: String): Boolean =
        store?.replayed(username.lowercase(), com.flagshipserver.app.core.pq.AssurancePolicy.Scope("installation", serverDomain.lowercase()))?.strict == true

    /**
     * Boot unlock v2: the account key's (IRK) hybrid half on this phone as the coordinator's owner
     * signer, whatever the policy; null when this phone holds no ML-DSA key for it.
     */
    fun ownerPqSigner(username: String, irk: com.flagshipserver.app.core.IrkMaterial): com.flagshipserver.app.core.SecretRequestCoordinator.OwnerPqSigner? {
        val keys = pqKeys ?: return null
        val entry = keys.entry("account-irk", username.lowercase()) ?: return null
        if (entry.ed25519PubHex != irk.pubHex.lowercase()) return null
        val pub = PqHex.decode(entry.ed25519PubHex + entry.mldsaPubHex) ?: return null
        return com.flagshipserver.app.core.SecretRequestCoordinator.OwnerPqSigner(pub) { purpose, payload ->
            keys.sign(entry, purpose, payload) { m -> irk.signer.sign(m) }
        }
    }

    /** This phone's device binding and hybrid signer, from keys the unlocked session holds. */
    fun deviceIdentity(user: String, deviceId: String): PqChannelInterceptor.Identity? {
        if (!SessionIrkAccess.isSessionUnlocked() || !Keystore.hasUmkSeed()) return null
        val keys = pqKeys ?: return null
        val entry = keys.entry("device", deviceId) ?: return null
        val umk = Keystore.currentUmkSeed()
        val signer = Keystore.accountDeviceSigner(umk, user, deviceId)
        val pub = PqHex.encode(Keystore.accountDevicePublicKey(umk, user, deviceId))
        if (entry.ed25519PubHex != pub) return null
        val sign = PqSession.Signer { purpose, payload -> keys.sign(entry, purpose, payload) { m -> signer.sign(m) } }
        val st = PqTrust.Statement("device", deviceId, pub, entry.mldsaPubHex, System.currentTimeMillis())
        val b = runCatching {
            PqTrust.verifyPqKeyBinding(PqTrust.signPqKeyBinding(st) { m -> sign.sign(PqTrust.TAG_PQ_KEY_BINDING, m) },
                PqTrust.Expectation("device", deviceId, pub, now = st.issuedAt))
        }.getOrNull() ?: return null
        return PqChannelInterceptor.Identity(b, sign)
    }

    /**
     * The hybrid signature over an order's canonical bytes by [key] (the admin root) and its
     * ML-DSA key on this phone, while any server is strict; null otherwise.
     */
    fun pqSignature(username: String, role: String, canonical: ByteArray, key: Ed25519Sign, keyPubHex: String): PqSignatureWire? {
        if (!anyStrict(username)) return null
        val keys = pqKeys ?: return null
        val entry = keys.entry(role, username.lowercase()) ?: return null
        if (entry.ed25519PubHex != keyPubHex.lowercase()) return null
        val purpose = PqTrust.messagePurpose(canonical)
        val sig = runCatching { keys.sign(entry, purpose, canonical) { m -> key.sign(m) } }.getOrNull() ?: return null
        return PqSignatureWire(PqTrust.SUITE_HYBRID, PqHex.encode(sig))
    }
}
