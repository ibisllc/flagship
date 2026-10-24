package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.pq.PqIdentityBinder
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Binds this phone's identities to ML-DSA-65 keys (architecture v2 milestone 2): the account
 * IRK, the admin root when this phone holds it, and this device's own key. Triggered at account
 * creation, after joining an account, after an admin-root setup or rotation, and after every
 * unlock, so existing accounts upgrade at their next unlock. It only runs while the app session
 * is already unlocked (it never shows a prompt), skips demo accounts, and anything it can't
 * finish (no network, a re-pair still waiting, the Keystore wants a fresh authentication) is
 * simply tried again at the next trigger.
 */
object PqIdentityUpgrade {
    /** Who is signed in on this phone right now, or null to do nothing. */
    data class Account(val username: String, val deviceId: String?, val isDemo: Boolean)

    @Volatile var binder: PqIdentityBinder? = null
    @Volatile var account: (() -> Account?)? = null
    @Volatile var sessionUnlocked: () -> Boolean = { SessionIrkAccess.isSessionUnlocked() }
    @Volatile var scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val running = AtomicBoolean(false)
    private val DEVICE_ID = Regex("^[0-9a-f]{32}$")

    /** Fire-and-forget; safe to call from any thread, any number of times. */
    fun trigger() {
        if (binder == null || !sessionUnlocked()) return
        scope.launch { runOnce() }
    }

    /** One pass; returns the outcome per role, or null when it did nothing. */
    suspend fun runOnce(): Map<String, PqIdentityBinder.Outcome>? {
        val b = binder ?: return null
        val a = account?.invoke() ?: return null
        if (a.isDemo || !sessionUnlocked()) return null
        if (!running.compareAndSet(false, true)) return null
        return try {
            b.bindAll(a.username, identities(a))
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        } finally {
            running.set(false)
        }
    }

    /** The identities this phone holds for [a], with their Ed25519 halves. Never prompts: the
     *  session is unlocked, so deriveIRK's gate passes straight through. */
    internal suspend fun identities(a: Account): List<PqIdentityBinder.Identity> {
        if (!Keystore.hasUmkSeed()) return emptyList()
        val user = a.username.lowercase()
        val out = ArrayList<PqIdentityBinder.Identity>(3)
        val irk = KeystoreIrkAccess().resolve("Protect your account keys")
        out += PqIdentityBinder.Identity("account-irk", user, irk.pubHex) { m -> irk.signer.sign(m) }
        val rootSeed = Keystore.adminRootSeed()
        if (rootSeed != null && rootSeed.size == 32) {
            val root = Ed25519Sign(rootSeed)
            val pub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(rootSeed).publicKey)
            out += PqIdentityBinder.Identity("admin-root", user, pub) { m -> root.sign(m) }
        }
        val deviceId = a.deviceId?.lowercase()
        if (deviceId != null && DEVICE_ID.matches(deviceId)) {
            val umk = Keystore.currentUmkSeed()
            val signer = Keystore.accountDeviceSigner(umk, user, deviceId)
            val pub = HexUtil.encode(Keystore.accountDevicePublicKey(umk, user, deviceId))
            out += PqIdentityBinder.Identity("device", deviceId, pub) { m -> signer.sign(m) }
        }
        return out
    }
}
