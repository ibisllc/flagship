// Manual "Lock and turn off" / "Lock and restart" — signs a `power-off`
// PhoneOrder with the OWNER IRK and POSTs it straight to the box's
// `/api/power`. See docs/lock-and-poweroff.md. Mirror of iOS
// LockPowerViewModel.
//
// SIGNER: the order is verified by the daemon at `/api/power` against the
// box's config-pinned owner IRK — the SAME key DeadManViewModel /
// RevokeServerViewModel sign with (biometric on every tap; never silent).
// The default `signer` is the real Keystore-backed IRK; tests inject a
// fixed key. The canonical bytes are UNCHANGED (the daemon's PSK/orders
// path is inert on a real box — this rides the IRK-verified power surface).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.UserErrorText
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.LockPowerClient
import com.flagshipserver.app.api.PowerOffOrderInner
import com.flagshipserver.app.api.PowerOffOrderRequest
import com.flagshipserver.app.core.BootLock
import com.flagshipserver.app.core.BootLockOutcome
import com.flagshipserver.app.core.BootLockStateStore
import com.flagshipserver.app.core.BootSuspensionOrder
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.LockWords
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.PowerMode
import com.flagshipserver.app.core.PowerOffOrder
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface PowerOffPhase {
    data object Idle : PowerOffPhase
    data object Signing : PowerOffPhase
    data object Posting : PowerOffPhase
    /** Order accepted by the box; UI shows powering-off/restarting → offline. */
    data class Completed(val mode: PowerMode) : PowerOffPhase
    data class Failed(val message: String) : PowerOffPhase
    /** A restart was requested but could not be locked at the boot service, so
     *  NOTHING was sent. The screen offers a shutdown instead. */
    data class LockUnconfirmed(val message: String) : PowerOffPhase
}

class PowerOffViewModel(
    private val serverDomain: String,
    /** Biometric-gated signer. Slice D — power-off is a SENSITIVE order
     *  (deadManHttp.ts / the box gates it on the admin master root): sign with the
     *  admin root when this device holds one, else the owner IRK (legacy). Only
     *  the signing KEY changes; the canonical bytes are byte-identical and the box
     *  resolves the signer by trial. Mirrors DeadManViewModel / RevokeServerViewModel. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val client: LockPowerClient = LockPowerClient(),
    private val now: () -> Long = { System.currentTimeMillis() },
    /** Locks the server at the boot service. Null on a box that doesn't unlock from the phone. */
    private val bootLock: BootLock? = null,
    /** The ACCOUNT key (never the admin root): the boot worker's owner role is the IRK. */
    private val irkSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val irkPubHex: suspend () -> String = { Keystore.irkPubHex() },
    private val lockStore: BootLockStateStore? = null,
) : ViewModel() {
    private val _phase = MutableStateFlow<PowerOffPhase>(PowerOffPhase.Idle)
    val phase: StateFlow<PowerOffPhase> = _phase.asStateFlow()

    /** The durable lock at the boot service, reported apart from the power order. */
    private val _lockOutcome = MutableStateFlow<BootLockOutcome?>(null)
    val lockOutcome: StateFlow<BootLockOutcome?> = _lockOutcome.asStateFlow()

    /** What the screen says about the last action, in words that don't overclaim. */
    private val _summary = MutableStateFlow("")
    val summary: StateFlow<String> = _summary.asStateFlow()

    suspend fun run(mode: PowerMode) {
        _summary.value = ""
        _lockOutcome.value = null
        _phase.value = PowerOffPhase.Signing
        val reason = if (mode == PowerMode.RESTART) "Lock and restart $serverDomain" else "Lock and turn off $serverDomain"
        var accountKey: Ed25519Sign? = null
        var accountPub: String? = null
        if (bootLock != null) {
            try {
                accountKey = irkSigner(reason)
                accountPub = irkPubHex()
            } catch (e: Throwable) {
                _phase.value = PowerOffPhase.Failed("Couldn't access your account key: ${UserErrorText.reason(e)}")
                return
            }
        }

        // A restart is sent only once the lock is durable: a reboot into a lease that was
        // never revoked is exactly what the lock exists to prevent.
        if (mode == PowerMode.RESTART && bootLock != null && accountKey != null && accountPub != null) {
            _phase.value = PowerOffPhase.Posting
            val lock = bootLock.setOwner(serverDomain, BootSuspensionOrder.Action.SUSPEND, accountKey, accountPub)
            _lockOutcome.value = lock
            if (lock !is BootLockOutcome.Confirmed) {
                lockStore?.markPending(serverDomain)
                val msg = "Couldn't lock this server at the boot service, so it was not restarted. " +
                    "Shut it down instead? It will lock as soon as the service answers."
                _summary.value = msg
                _phase.value = PowerOffPhase.LockUnconfirmed(msg)
                return
            }
            lockStore?.setLastKnown(true, serverDomain)
            lockStore?.clearPending(serverDomain)
        }

        sendPower(mode, reason, if (mode == PowerMode.OFF && bootLock != null && accountKey != null && accountPub != null) Triple(bootLock, accountKey, accountPub) else null)
    }

    /** The user chose "shut down" after a restart could not be locked. */
    suspend fun shutDownInstead() = run(PowerMode.OFF)

    /** Retry a lock the boot service did not confirm earlier. */
    suspend fun retryPendingLock(): BootLockOutcome? {
        val b = bootLock ?: return null
        val (key, pub) = try { irkSigner("Lock $serverDomain") to irkPubHex() } catch (_: Throwable) { return null }
        val r = b.setOwner(serverDomain, BootSuspensionOrder.Action.SUSPEND, key, pub)
        if (r is BootLockOutcome.Confirmed) { lockStore?.setLastKnown(true, serverDomain); lockStore?.clearPending(serverDomain) }
        _lockOutcome.value = r
        return r
    }

    /** Resume: a signed new epoch. Resume alone deposits no lease; auto-unlock re-arms at the next phone approval. */
    suspend fun resume(): BootLockOutcome? {
        val b = bootLock ?: return null
        val (key, pub) = try { irkSigner("Resume $serverDomain") to irkPubHex() } catch (_: Throwable) { return null }
        val r = b.setOwner(serverDomain, BootSuspensionOrder.Action.RESUME, key, pub)
        if (r is BootLockOutcome.Confirmed) { lockStore?.setLastKnown(false, serverDomain); lockStore?.clearPending(serverDomain) }
        return r
    }

    /** Sign and POST the power order; for "off" the lock is made at the same time and the
     *  power order never waits for the boot service. */
    private suspend fun sendPower(
        mode: PowerMode,
        reason: String,
        concurrentLock: Triple<BootLock, Ed25519Sign, String>?,
    ) {
        val irk: Ed25519Sign
        try {
            irk = signer(reason)
        } catch (e: Throwable) {
            _phase.value = PowerOffPhase.Failed(FSStrings.get(R.string.couldnt_access_your_account_key, UserErrorText.reason(e)))
            return
        }
        val issuedAt = now()
        val signature: ByteArray
        try {
            signature = irk.sign(PowerOffOrder.canonicalBytes(serverDomain, mode, issuedAt))
        } catch (e: Throwable) {
            _phase.value = PowerOffPhase.Failed(FSStrings.get(R.string.couldnt_sign, UserErrorText.reason(e)))
            return
        }

        _phase.value = PowerOffPhase.Posting
        var failure: String? = null
        var executed: PowerMode = mode
        coroutineScope {
            val lockJob = concurrentLock?.let { (lock, key, pub) ->
                async { lock.setOwner(serverDomain, BootSuspensionOrder.Action.SUSPEND, key, pub) }
            }
            try {
                val ack = client.sendPowerOff(
                    serverDomain,
                    PowerOffOrderRequest(
                        request = PowerOffOrderInner(serverId = serverDomain, mode = mode.wire, issuedAt = issuedAt),
                        signature = HexUtil.encode(signature),
                    ),
                )
                executed = ack.mode?.let { PowerMode.fromWire(it) } ?: mode
            } catch (e: HttpException) {
                failure = when (e.status) {
                    403 -> "The server rejected the request. Sign in again and retry."
                    404, 502, 503 -> "The server isn't reachable right now."
                    else -> "Server error (${e.status}): ${e.body}"
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                failure = UserErrorText.of(e, where = "reach")
            }
            lockJob?.await()?.let { lock ->
                _lockOutcome.value = lock
                if (lock is BootLockOutcome.Confirmed) { lockStore?.setLastKnown(true, serverDomain); lockStore?.clearPending(serverDomain) }
                else lockStore?.markPending(serverDomain)
            }
        }
        if (failure != null) {
            _summary.value = LockWords.describe(_lockOutcome.value, false, mode)
            _phase.value = PowerOffPhase.Failed(failure!!)
            return
        }
        _summary.value = LockWords.describe(_lockOutcome.value, true, mode, if (executed != mode) executed else null)
        _phase.value = PowerOffPhase.Completed(executed)
    }
}
