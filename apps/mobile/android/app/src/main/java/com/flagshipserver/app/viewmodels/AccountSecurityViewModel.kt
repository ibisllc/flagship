// v1.2 Phase 4 — Settings → Account security → Code protection. Kotlin
// mirror of the iOS AccountSecurityViewModel. Drives:
//
//   1. Load the account-type badge (single vs multi-device).
//   2. Four-step enrollment (explainer → QR → sample code → recovery
//      codes display).
//   3. Disable an existing enrollment (Phase 3 endpoint; refused by
//      the Worker when other paired sessions still exist).
//
// Turning code protection on or off is an admin order (owner, 2026-11-23;
// security report F2): enroll-begin / enroll-confirm / disable are signed with
// the admin root (Keystore.adminSigningKey, the IRK only on an account with
// no admin root), `.com` refuses anything else with `totp-admin-only`, and a
// device that isn't an admin sees the setting read-only ([canChange]).
// `.com`'s refusals carry a `code`, which [CodeProtectionText] words.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.UserErrorText
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.TotpDisableRequest
import com.flagshipserver.app.api.TotpEnrollBeginRequest
import com.flagshipserver.app.api.TotpEnrollConfirmRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.RateLimitedException
import com.flagshipserver.app.core.Variant
import com.flagshipserver.app.keystore.Keystore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
    /** Whether this device may turn code protection on or off: an admin
     *  device (or a demo account's), `AddServerGate.allows`. */
    val canChange: () -> Boolean = { Variant.forceAdminRoot || Keystore.hasAdminRoot() },
    private val sign: suspend (reason: String, bytes: ByteArray) -> ByteArray = { reason, bytes ->
        Keystore.adminSigningKey(reason).sign(bytes)
    },
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
            _phase.value = AccountSecurityPhase.Failed(FSStrings.get(R.string.no_active_account_on_this_device))
            return
        }
        if (!canChange()) {
            _phase.value = AccountSecurityPhase.Failed(CodeProtectionText.adminOnly)
            return
        }
        _phase.value = AccountSecurityPhase.Beginning

        val issuedAt = System.currentTimeMillis()
        val signature = try {
            sign(FSStrings.get(R.string.turn_on_code_protection), canonicalEnrollBegin(user, issuedAt))
        } catch (e: Throwable) {
            _phase.value = AccountSecurityPhase.Failed(FSStrings.get(R.string.couldnt_sign_enroll_begin, UserErrorText.reason(e)))
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
            _phase.value = AccountSecurityPhase.Failed(
                CodeProtectionText.refusal(e)
                    ?: FSStrings.get(R.string.couldnt_start_enrollment, UserErrorText.of(e, where = "totp-enroll-begin")),
            )
            if (CodeProtectionText.codeOf(e) == "totp-already-enrolled") load()
        }
    }

    suspend fun confirmEnrollment(sampleCode: String) {
        val trimmed = sampleCode.trim()
        if (trimmed.isEmpty()) {
            _phase.value = AccountSecurityPhase.Failed(FSStrings.get(R.string.enter_the_6_digit_code_from))
            return
        }
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = AccountSecurityPhase.Failed(FSStrings.get(R.string.no_active_account_on_this_device))
            return
        }
        if (!canChange()) {
            _phase.value = AccountSecurityPhase.Failed(CodeProtectionText.adminOnly)
            return
        }
        _phase.value = AccountSecurityPhase.Confirming

        val issuedAt = System.currentTimeMillis()
        val signature = try {
            sign(FSStrings.get(R.string.confirm_2fa_code), canonicalEnrollConfirm(user, issuedAt))
        } catch (e: Throwable) {
            _phase.value = AccountSecurityPhase.Failed(FSStrings.get(R.string.couldnt_sign_enroll_confirm, UserErrorText.reason(e)))
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
            val code = CodeProtectionText.codeOf(e)
            val wrongCode = (e as? HttpException)?.status == 401 && (code == null || code == "invalid-totp-code")
            _phase.value = AccountSecurityPhase.Failed(
                if (wrongCode) {
                    FSStrings.get(R.string.that_code_didnt_match_try_again)
                } else {
                    CodeProtectionText.refusal(e)
                        ?: FSStrings.get(R.string.couldnt_confirm, UserErrorText.of(e, where = "totp-enroll-confirm"))
                },
            )
            if (code == "totp-already-enrolled") load()
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
            _phase.value = AccountSecurityPhase.Failed(FSStrings.get(R.string.enter_your_6_digit_code_or))
            return
        }
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = AccountSecurityPhase.Failed(FSStrings.get(R.string.no_active_account_on_this_device))
            return
        }
        if (!canChange()) {
            _phase.value = AccountSecurityPhase.Failed(CodeProtectionText.adminOnly)
            return
        }
        _phase.value = AccountSecurityPhase.Disabling
        val issuedAt = System.currentTimeMillis()
        val signature = try {
            sign(FSStrings.get(R.string.turn_off_code_protection), canonicalDisable(user, issuedAt))
        } catch (e: Throwable) {
            _phase.value = AccountSecurityPhase.Failed(FSStrings.get(R.string.couldnt_sign_disable, UserErrorText.reason(e)))
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
            val code = CodeProtectionText.codeOf(e)
            _phase.value = AccountSecurityPhase.Failed(
                CodeProtectionText.refusal(e)
                    ?: if ((e as? HttpException)?.status == 409) {
                        FSStrings.get(R.string.disable_refused_other_devices_are_still)
                    } else {
                        FSStrings.get(R.string.couldnt_disable, UserErrorText.of(e, where = "totp-disable"))
                    },
            )
            if (code == "totp-not-enrolled") {
                _accountType.value = "single"
                _totpEnrolledAt.value = null
            }
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

/** `.com`'s code protection refusals (packages/control-plane/src/totp.ts
 *  `TotpRefusalCode`) as sentences, read from the status and the body's
 *  `code`, never from the exception's text. Mirrors iOS `CodeProtectionText`
 *  and the webapp's lib/totp.js `totpRefusalText`. */
object CodeProtectionText {
    val adminOnly get() = FSStrings.get(R.string.only_an_admin_device_can_change_code_protection)
    val alreadyOn get() = FSStrings.get(R.string.code_protection_already_on)
    val alreadyOff get() = FSStrings.get(R.string.code_protection_already_off)
    val notAvailable get() = FSStrings.get(R.string.code_protection_isnt_available_on_this)
    val expired get() = FSStrings.get(R.string.code_protection_setup_expired)
    val wrongCode get() = FSStrings.get(R.string.that_code_didnt_match_try_a)
    val otherDevices get() = FSStrings.get(R.string.disable_refused_other_devices_are_still)
    val accountNotFound get() = FSStrings.get(R.string.code_protection_account_not_found)

    private val json = Json { ignoreUnknownKeys = true }

    /** The `code` of a refused call's JSON body, if it has one. */
    fun codeOf(t: Throwable): String? {
        val body = (t as? HttpException)?.body ?: return null
        val obj = runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
        return (obj["code"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }

    /** The sentence for one of `.com`'s refusals, or null for anything else
     *  (transport, decoding), which [UserErrorText] words. */
    fun refusal(t: Throwable): String? {
        RateLimitedException.messageOf(t)?.let { return it }
        val status = (t as? HttpException)?.status ?: return null
        return when (codeOf(t)) {
            "totp-admin-only" -> adminOnly
            "totp-already-enrolled" -> alreadyOn
            "totp-not-enrolled" -> alreadyOff
            "totp-not-configured" -> notAvailable
            "totp-pending-expired", "totp-no-pending" -> expired
            "invalid-totp-code" -> wrongCode
            "totp-other-devices" -> otherDevices
            "account-not-found" -> accountNotFound
            "internal-error" -> UserErrorText.SERVER_PROBLEM
            else -> when (status) {
                503 -> notAvailable
                401 -> wrongCode
                else -> null
            }
        }
    }
}
