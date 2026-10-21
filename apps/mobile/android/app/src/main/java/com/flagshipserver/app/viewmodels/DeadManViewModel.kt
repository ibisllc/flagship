// Dead-man heartbeat-lock opt-in + the manual affirmation loop. The phone
// periodically prompts the user for a biometric-gated affirmation that
// renews a dead-man lease distinct from the silent auto-unlock lease; on
// lapse the box powers off (or restarts). See docs/lock-and-poweroff.md.
// Mirror of iOS DeadManViewModel.
//
// Both envelopes are owner-IRK-signed (biometric on every enable/change and
// every affirmation — NEVER silent, so a stolen/unattended phone can't renew).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.UserErrorText
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.DeadManAffirmInner
import com.flagshipserver.app.api.DeadManAffirmRequest
import com.flagshipserver.app.api.DeadManPolicyInner
import com.flagshipserver.app.api.DeadManPolicyRequest
import com.flagshipserver.app.api.LockPowerClient
import com.flagshipserver.app.core.BootLock
import com.flagshipserver.app.core.DeadManAffirmation
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.PowerMode
import com.flagshipserver.app.core.SetDeadManPolicy
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.SecureRandom

/** Window presets the UI offers. Default is 24h; tightenable down to minutes. */
enum class DeadManWindow(val label: String, val windowMs: Long) {
    H24("24 hours", 24L * 3600_000),
    H8("8 hours", 8L * 3600_000),
    H1("1 hour", 1L * 3600_000),
    M15("15 minutes", 15L * 60_000),
    M5("5 minutes", 5L * 60_000);

    companion object {
        val DEFAULT = H24
        /** "Tighten now" target — the shortest practical window. */
        val TIGHTEN = M5
        fun fromMs(ms: Long): DeadManWindow? = entries.firstOrNull { it.windowMs == ms }
    }
}

sealed interface DeadManPhase {
    data object Idle : DeadManPhase
    data object Signing : DeadManPhase
    data object Posting : DeadManPhase
    data object Completed : DeadManPhase
    data class Failed(val message: String) : DeadManPhase
}

class DeadManViewModel(
    private val serverDomain: String,
    private val username: () -> String?,
    /** Biometric-gated IRK signer. Default uses the real Keystore IRK; the
     *  caller passes the reason string for the prompt. */
    private val signer: suspend (reason: String) -> Ed25519Sign,
    private val client: LockPowerClient = LockPowerClient(),
    private val now: () -> Long = { System.currentTimeMillis() },
    private val nonceGen: () -> ByteArray = { ByteArray(16).also(rng::nextBytes) },
    /** Revokes the server's auto-unlock leases before the switch is enabled, so none outlives it. */
    private val bootLock: BootLock? = null,
    private val irkSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val irkPubHex: suspend () -> String = { Keystore.irkPubHex() },
) : ViewModel() {
    /** The first affirmation deadline the box set when the switch was last enabled (null from an older box). */
    var lastPolicyLeaseExpiry: Long? = null
        private set

    private val _phase = MutableStateFlow<DeadManPhase>(DeadManPhase.Idle)
    val phase: StateFlow<DeadManPhase> = _phase.asStateFlow()

    /** Default grace = 6h regardless of window (matches the spec + TS default). */
    var graceMs: Long = 6L * 3600_000

    /** Enable / change the policy. Biometric-gated (the signer prompts).
     *  Returns true on success. */
    suspend fun setPolicy(
        enabled: Boolean,
        window: DeadManWindow,
        lockoutMode: PowerMode,
    ): Boolean {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = DeadManPhase.Failed(FSStrings.get(R.string.no_active_account_on_this_device))
            return false
        }
        // Turning the switch on: first remove every auto-unlock lease, because none may outlive the
        // affirmation. Auto-unlock re-arms at your next phone approval, bounded by the deadline.
        if (enabled && bootLock != null) {
            try {
                bootLock.revokeAllLeases(serverDomain, irkSigner("Remove auto-unlock for $serverDomain"), irkPubHex())
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                _phase.value = DeadManPhase.Failed(
                    "Couldn't remove this server's auto-unlock lease, so the lock-down was not turned on. ${UserErrorText.reason(e)}",
                )
                return false
            }
        }
        _phase.value = DeadManPhase.Signing
        val irk: Ed25519Sign
        try {
            val verb = if (enabled) "Arm" else "Disarm"
            irk = signer(FSStrings.get(R.string.dead_man_lock_for, verb, serverDomain))
        } catch (e: Throwable) {
            _phase.value = DeadManPhase.Failed(FSStrings.get(R.string.couldnt_access_your_account_key, UserErrorText.reason(e)))
            return false
        }
        val issuedAt = now()
        val signature: ByteArray
        try {
            signature = irk.sign(
                SetDeadManPolicy.canonicalBytes(
                    serverId = serverDomain,
                    enabled = enabled,
                    windowMs = window.windowMs,
                    graceMs = graceMs,
                    lockoutMode = lockoutMode,
                    issuedAt = issuedAt,
                ),
            )
        } catch (e: Throwable) {
            _phase.value = DeadManPhase.Failed(FSStrings.get(R.string.couldnt_sign, UserErrorText.reason(e)))
            return false
        }

        _phase.value = DeadManPhase.Posting
        try {
            val ack = client.setDeadManPolicy(
                serverDomain,
                DeadManPolicyRequest(
                    request = DeadManPolicyInner(
                        serverId = serverDomain,
                        enabled = enabled,
                        windowMs = window.windowMs,
                        graceMs = graceMs,
                        lockoutMode = lockoutMode.wire,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
            lastPolicyLeaseExpiry = ack.leaseExpiry?.takeIf { it > 0 }
        } catch (e: HttpException) {
            _phase.value = DeadManPhase.Failed(friendly(e))
            return false
        } catch (e: Throwable) {
            _phase.value = DeadManPhase.Failed(UserErrorText.of(e, where = "reach"))
            return false
        }
        _phase.value = DeadManPhase.Completed
        return true
    }

    /** Manual keep-unlocked affirmation. Fresh nonce each call; biometric-gated.
     *  Returns the new lease-expiry epoch-ms reported by the box, or null. */
    suspend fun affirm(): Long? {
        val irk: Ed25519Sign
        try {
            irk = signer(FSStrings.get(R.string.keep_unlocked_2, serverDomain))
        } catch (e: Throwable) {
            _phase.value = DeadManPhase.Failed(FSStrings.get(R.string.couldnt_access_your_account_key, UserErrorText.reason(e)))
            return null
        }
        val nonce = nonceGen()
        val issuedAt = now()
        val signature: ByteArray
        try {
            signature = irk.sign(
                DeadManAffirmation.canonicalBytes(serverDomain, nonce, issuedAt),
            )
        } catch (e: Throwable) {
            _phase.value = DeadManPhase.Failed(FSStrings.get(R.string.couldnt_sign, UserErrorText.reason(e)))
            return null
        }

        _phase.value = DeadManPhase.Posting
        val ack: Long?
        try {
            val res = client.affirm(
                serverDomain,
                DeadManAffirmRequest(
                    request = DeadManAffirmInner(
                        serverId = serverDomain,
                        nonce = HexUtil.encode(nonce),
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
            ack = res.leaseExpiry
        } catch (e: HttpException) {
            _phase.value = DeadManPhase.Failed(friendly(e))
            return null
        } catch (e: Throwable) {
            _phase.value = DeadManPhase.Failed(UserErrorText.of(e, where = "reach"))
            return null
        }
        _phase.value = DeadManPhase.Completed
        return ack
    }

    private fun friendly(e: HttpException): String = when (e.status) {
        403 -> FSStrings.get(R.string.the_server_rejected_the_request_sign)
        404, 502, 503 -> FSStrings.get(R.string.the_server_isnt_reachable_right_now)
        else -> FSStrings.get(R.string.server_error, e.status, e.body)
    }

    companion object {
        private val rng = SecureRandom()
    }
}
