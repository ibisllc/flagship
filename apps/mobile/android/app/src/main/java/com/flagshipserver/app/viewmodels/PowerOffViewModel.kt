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

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.LockPowerClient
import com.flagshipserver.app.api.PowerOffOrderInner
import com.flagshipserver.app.api.PowerOffOrderRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.PowerMode
import com.flagshipserver.app.core.PowerOffOrder
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
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
}

class PowerOffViewModel(
    private val serverDomain: String,
    /** Biometric-gated owner-IRK signer. Default uses the real Keystore IRK;
     *  the caller passes the reason string for the prompt. Mirrors
     *  DeadManViewModel / RevokeServerViewModel. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val client: LockPowerClient = LockPowerClient(),
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    private val _phase = MutableStateFlow<PowerOffPhase>(PowerOffPhase.Idle)
    val phase: StateFlow<PowerOffPhase> = _phase.asStateFlow()

    suspend fun run(mode: PowerMode) {
        _phase.value = PowerOffPhase.Signing
        val irk: Ed25519Sign
        try {
            val reason = if (mode == PowerMode.RESTART) {
                "Lock and restart $serverDomain"
            } else {
                "Lock and turn off $serverDomain"
            }
            irk = signer(reason)
        } catch (e: Throwable) {
            _phase.value = PowerOffPhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }
        val issuedAt = now()
        val signature: ByteArray
        try {
            signature = irk.sign(PowerOffOrder.canonicalBytes(serverDomain, mode, issuedAt))
        } catch (e: Throwable) {
            _phase.value = PowerOffPhase.Failed("Couldn't sign: ${e.message}")
            return
        }

        _phase.value = PowerOffPhase.Posting
        try {
            client.sendPowerOff(
                serverDomain,
                PowerOffOrderRequest(
                    request = PowerOffOrderInner(
                        serverId = serverDomain,
                        mode = mode.wire,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
        } catch (e: HttpException) {
            val friendly = when (e.status) {
                403 -> "The box rejected the request. Sign in again and retry."
                404, 502, 503 -> "The box isn't reachable right now."
                else -> "Server error (${e.status}): ${e.body}"
            }
            _phase.value = PowerOffPhase.Failed(friendly)
            return
        } catch (e: Throwable) {
            _phase.value = PowerOffPhase.Failed("Couldn't reach the box: ${e.message}")
            return
        }
        _phase.value = PowerOffPhase.Completed(mode)
    }
}
