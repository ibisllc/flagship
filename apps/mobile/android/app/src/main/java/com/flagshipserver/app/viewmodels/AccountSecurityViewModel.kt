// v1.2 Phase 4 — Settings → Multi-device + 2FA. Kotlin mirror of the
// iOS AccountSecurityViewModel. Drives:
//
//   1. Load the account-type badge (single vs multi-device).
//   2. Four-step enrollment (explainer → QR → sample code → recovery
//      codes display).
//   3. Disable an existing enrollment (Phase 3 endpoint; refused by
//      the Worker when other paired sessions still exist).
//
// IRK signatures for enroll-begin / enroll-confirm / disable are
// produced from the current Keystore IRK seed — same primitive
// ReplaceDeviceViewModel uses.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.TotpDisableRequest
import com.flagshipserver.app.api.TotpEnrollBeginRequest
import com.flagshipserver.app.api.TotpEnrollConfirmRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface AccountSecurityPhase {
    data object Idle : AccountSecurityPhase
    data object Beginning : AccountSecurityPhase
    data class Staged(
        val secret: String,
        val otpauthUrl: String,
        val qrPngBase64: String,
        val issuer: String,
    ) : AccountSecurityPhase
    data object Confirming : AccountSecurityPhase
    data class Confirmed(
        val totpEnrolledAt: Long,
        val recoveryCodes: List<String>,
    ) : AccountSecurityPhase
    data object Disabling : AccountSecurityPhase
    data object Disabled : AccountSecurityPhase
    data class Failed(val message: String) : AccountSecurityPhase
}

class AccountSecurityViewModel(
    private val server: FlagshipServerClient,
    private val username: () -> String?,
) : ViewModel() {

    private val _phase = MutableStateFlow<AccountSecurityPhase>(AccountSecurityPhase.Idle)
    val phase: StateFlow<AccountSecurityPhase> = _phase.asStateFlow()

    /** Current account-type badge ("single" / "multi"). Null while
     *  loading or after a failure. */
    private val _accountType = MutableStateFlow<String?>(null)
    val accountType: StateFlow<String?> = _accountType.asStateFlow()

    private val _totpEnrolledAt = MutableStateFlow<Long?>(null)
    val totpEnrolledAt: StateFlow<Long?> = _totpEnrolledAt.asStateFlow()

    /** Convenience for the badge label/copy. */
    val isMultiDevice: Boolean get() = _accountType.value == "multi"

    suspend fun load() {
        val user = username()
        if (user.isNullOrEmpty()) {
            _accountType.value = null
            _totpEnrolledAt.value = null
            return
        }
        try {
            val rec = server.getUsernameRecord(user)
            _accountType.value = rec.accountType
            _totpEnrolledAt.value = rec.totpEnrolledAt
        } catch (_: Throwable) {
            _accountType.value = null
            _totpEnrolledAt.value = null
        }
    }

    suspend fun beginEnrollment() {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = AccountSecurityPhase.Failed("No active account on this device.")
            return
        }
        _phase.value = AccountSecurityPhase.Beginning

        val issuedAt = System.currentTimeMillis()
        val signature = try {
            val signer = Keystore.deriveIRK("Enable multi-device + 2FA", Keystore.currentIrkVersion())
            signer.sign(canonicalEnrollBegin(user, issuedAt))
        } catch (e: Throwable) {
            _phase.value = AccountSecurityPhase.Failed("Couldn't sign enroll-begin: ${e.message}")
            return
        }

        try {
            val resp = server.totpEnrollBegin(
                username = user,
                body = TotpEnrollBeginRequest(
                    request = TotpEnrollBeginRequest.Inner(username = user, issuedAt = issuedAt),
                    signature = HexUtil.encode(signature),
                ),
            )
            _phase.value = AccountSecurityPhase.Staged(
                secret = resp.secret,
                otpauthUrl = resp.otpauthUrl,
                qrPngBase64 = resp.qrPngBase64,
                issuer = resp.issuer,
            )
        } catch (e: Throwable) {
            val msg = e.message.orEmpty()
            val friendly = if (msg.contains("503")) {
                "Multi-device + 2FA isn't configured on this server yet. Try again later."
            } else {
                "Couldn't start enrollment: $msg"
            }
            _phase.value = AccountSecurityPhase.Failed(friendly)
        }
    }

    suspend fun confirmEnrollment(sampleCode: String) {
        val trimmed = sampleCode.trim()
        if (trimmed.isEmpty()) {
            _phase.value = AccountSecurityPhase.Failed("Enter the 6-digit code from your authenticator app.")
            return
        }
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = AccountSecurityPhase.Failed("No active account on this device.")
            return
        }
        _phase.value = AccountSecurityPhase.Confirming

        val issuedAt = System.currentTimeMillis()
        val signature = try {
            val signer = Keystore.deriveIRK("Confirm 2FA code", Keystore.currentIrkVersion())
            signer.sign(canonicalEnrollConfirm(user, issuedAt))
        } catch (e: Throwable) {
            _phase.value = AccountSecurityPhase.Failed("Couldn't sign enroll-confirm: ${e.message}")
            return
        }

        try {
            val resp = server.totpEnrollConfirm(
                username = user,
                body = TotpEnrollConfirmRequest(
                    request = TotpEnrollConfirmRequest.Inner(username = user, issuedAt = issuedAt),
                    signature = HexUtil.encode(signature),
                    code = trimmed,
                ),
            )
            _accountType.value = resp.accountType
            _totpEnrolledAt.value = resp.totpEnrolledAt
            _phase.value = AccountSecurityPhase.Confirmed(
                totpEnrolledAt = resp.totpEnrolledAt,
                recoveryCodes = resp.recoveryCodes,
            )
        } catch (e: Throwable) {
            val msg = e.message.orEmpty()
            val friendly = if (msg.contains("401")) {
                "That code didn't match. Try again with a fresh code from your authenticator."
            } else {
                "Couldn't confirm: $msg"
            }
            _phase.value = AccountSecurityPhase.Failed(friendly)
        }
    }

    /** User has saved the recovery codes; dismiss the sheet and scrub
     *  the plaintexts from memory. The account-type / enrolled-at
     *  stays set since the Worker enrollment is committed. */
    fun dismissEnrollment() {
        _phase.value = AccountSecurityPhase.Idle
    }

    suspend fun disableEnrollment(code: String) {
        val trimmed = code.trim()
        if (trimmed.isEmpty()) {
            _phase.value = AccountSecurityPhase.Failed("Enter your 6-digit code or a recovery code to confirm.")
            return
        }
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = AccountSecurityPhase.Failed("No active account on this device.")
            return
        }
        _phase.value = AccountSecurityPhase.Disabling
        val issuedAt = System.currentTimeMillis()
        val signature = try {
            val signer = Keystore.deriveIRK("Disable multi-device + 2FA", Keystore.currentIrkVersion())
            signer.sign(canonicalDisable(user, issuedAt))
        } catch (e: Throwable) {
            _phase.value = AccountSecurityPhase.Failed("Couldn't sign disable: ${e.message}")
            return
        }
        try {
            val resp = server.totpDisable(
                username = user,
                body = TotpDisableRequest(
                    request = TotpDisableRequest.Inner(username = user, issuedAt = issuedAt),
                    signature = HexUtil.encode(signature),
                    code = trimmed,
                ),
            )
            _accountType.value = resp.accountType
            _totpEnrolledAt.value = null
            _phase.value = AccountSecurityPhase.Disabled
        } catch (e: Throwable) {
            val msg = e.message.orEmpty()
            val friendly = when {
                msg.contains("401") -> "That code didn't match. Try a fresh code from your authenticator."
                msg.contains("409") -> "Disable refused — other devices are still trusted on this account. Disconnect them first."
                else -> "Couldn't disable: $msg"
            }
            _phase.value = AccountSecurityPhase.Failed(friendly)
        }
    }

    companion object {
        /** Mirrors packages/protocol/src/auth.ts canonicalTotpEnrollBegin. */
        fun canonicalEnrollBegin(username: String, issuedAt: Long): ByteArray =
            "flagship/totp-enroll-begin/v1|$username|$issuedAt".toByteArray(Charsets.UTF_8)

        fun canonicalEnrollConfirm(username: String, issuedAt: Long): ByteArray =
            "flagship/totp-enroll-confirm/v1|$username|$issuedAt".toByteArray(Charsets.UTF_8)

        fun canonicalDisable(username: String, issuedAt: Long): ByteArray =
            "flagship/totp-disable/v1|$username|$issuedAt".toByteArray(Charsets.UTF_8)
    }
}
