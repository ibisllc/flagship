// UX-A + UX-B — one place that turns a transport throwable into plain language
// for a person, and surfaces the ONE security-relevant failure (a cert-pin
// mismatch) as its own distinguishable category so the UI can warn rather than
// show a generic "network error".
//
// Categories:
//   - CertPinMismatch — the box served a cert that did NOT match its
//     STK-signed fingerprint (CertPinInterceptor / CertPinHostnameVerifier
//     hard-fail). This is NOT an ordinary offline/timeout: it means someone
//     may be intercepting the connection. We must NOT fold it into "you're
//     offline" — it gets its own, louder copy.
//   - RateLimited — `.com`'s rate limiter (429 `rate-limited`): who is limited
//     and when to try again (RateLimitedException).
//   - Offline — no network at all (UnknownHost / connect failure / timeout).
//   - ServerProblem — a 5xx from the backend (transient; try again).
//   - RequestProblem — a 4xx other than the cert case (check your connection /
//     the link).
//   - Passkey — the passkey app refused, was cancelled, or didn't hand back
//     the key Flagship derives (PasskeyRecoveryManager.RecoveryError).
//   - Unknown — anything we can't classify; never leak a raw status/stack to
//     the user. Its sentence carries a short code, and [humanize] logs the
//     class and message under the same code (never keys or passphrases), so
//     a report can be matched to the log.
//
// Raw HTTP status codes and exception messages are intentionally kept OUT of
// the user-facing string (UX-B): a bare "HTTP 503" or "SSLHandshakeException"
// means nothing to a normal person.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLPeerUnverifiedException

/** Implemented by any transport error that carries an HTTP status code, so the
 *  humanizer can map it to plain language without depending on the api layer
 *  (HttpException, ScreensError.Http). */
interface HasHttpStatus {
    val httpStatus: Int
}

object NetworkErrorHumanizer {

    enum class Kind {
        CERT_PIN_MISMATCH,
        RATE_LIMITED,
        OFFLINE,
        SERVER_PROBLEM,
        REQUEST_PROBLEM,
        PASSKEY,
        BIOMETRIC,
        UNKNOWN,
    }

    data class Classified(val kind: Kind, val message: String)

    /** The substring CertPinInterceptor.enforce stamps into the
     *  SSLPeerUnverifiedException it throws on a pin mismatch — the marker that
     *  tells an intercepted-cert failure apart from any other TLS failure. */
    private const val PIN_MARKER = "STK-signed"

    fun classify(t: Throwable): Classified {
        val rateLimit = RateLimitedException.from(t)
        return when {
            isCertPinMismatch(t) -> Classified(
                Kind.CERT_PIN_MISMATCH,
                FSStrings.get(R.string.this_servers_certificate_doesnt_match),
            )
            rateLimit != null -> Classified(Kind.RATE_LIMITED, rateLimit.userMessage)
            t is AddServerRefused || AddServerGate.isServerRefusal(t) -> Classified(Kind.REQUEST_PROBLEM, AddServerGate.ADMIN_ONLY)
            passkeyError(t) != null -> Classified(Kind.PASSKEY, passkeySentence(passkeyError(t)!!))
            t is com.flagshipserver.app.keystore.BiometricCancelled ->
                Classified(Kind.BIOMETRIC, FSStrings.get(R.string.cancelled_try_again_when_youre_ready))
            t is com.flagshipserver.app.keystore.BiometricFailed -> Classified(Kind.BIOMETRIC, biometricSentence(t))
            t is HttpException -> classifyStatus(t.status)
            t is HasHttpStatus -> classifyStatus(t.httpStatus)
            isOffline(t) -> Classified(
                Kind.OFFLINE,
                FSStrings.get(R.string.youre_offline_check_your_connection_and),
            )
            else -> Classified(
                Kind.UNKNOWN,
                FSStrings.get(R.string.something_went_wrong_code_please_try, errorCode(t)),
            )
        }
    }

    /** The human string (UX-B mapping). Logs what it hides: the error's
     *  class, message and causes, tagged with [where] and the error code. */
    fun humanize(t: Throwable, where: String = "error"): String =
        UserErrorText.of(t, where = where)

    /** A short, stable code for an error's class, shown to the person and
     *  logged beside the details. */
    fun errorCode(t: Throwable): String =
        "%04X".format((t.javaClass.name.hashCode() xor (t.cause?.javaClass?.name?.hashCode() ?: 0)) and 0xFFFF)

    private fun passkeyError(t: Throwable): com.flagshipserver.app.keystore.PasskeyRecoveryManager.RecoveryError? {
        var cur: Throwable? = t
        while (cur != null) {
            if (cur is com.flagshipserver.app.keystore.PasskeyRecoveryManager.RecoveryError) return cur
            cur = cur.cause
        }
        return null
    }

    private fun biometricSentence(e: com.flagshipserver.app.keystore.BiometricFailed): String = when {
        e.isLockout -> FSStrings.get(R.string.too_many_tries_unlock_your_phone)
        e.code == com.flagshipserver.app.keystore.BiometricFailed.NOT_STARTED ->
            FSStrings.get(R.string.your_phone_didnt_show_the_fingerprint)
        e.code == com.flagshipserver.app.keystore.BiometricFailed.SCREEN_GONE ->
            FSStrings.get(R.string.the_app_closed_before_the_check)
        e.code == androidx.biometric.BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL ||
            e.code == androidx.biometric.BiometricPrompt.ERROR_NO_BIOMETRICS ->
            FSStrings.get(R.string.set_a_screen_lock_pin_pattern)
        else -> FSStrings.get(R.string.couldnt_check_your_fingerprint_or_screen)
    }

    val PASSKEY_NO_KEY get() =
        FSStrings.get(R.string.your_passkey_app_didnt_return_the)

    private fun passkeySentence(e: com.flagshipserver.app.keystore.PasskeyRecoveryManager.RecoveryError): String {
        return when (e) {
            is com.flagshipserver.app.keystore.PasskeyRecoveryManager.RecoveryError.PrfUnavailable,
            is com.flagshipserver.app.keystore.PasskeyRecoveryManager.RecoveryError.KeyNotReturned -> PASSKEY_NO_KEY
            is com.flagshipserver.app.keystore.PasskeyRecoveryManager.RecoveryError.CreateFailed -> when (e.cause0) {
                is androidx.credentials.exceptions.CreateCredentialCancellationException ->
                    FSStrings.get(R.string.you_cancelled_saving_the_passkey_try)
                is androidx.credentials.exceptions.CreateCredentialNoCreateOptionException ->
                    FSStrings.get(R.string.no_passkey_app_on_this_phone)
                else -> FSStrings.get(R.string.your_passkey_app_couldnt_save_a)
            }
            is com.flagshipserver.app.keystore.PasskeyRecoveryManager.RecoveryError.GetFailed -> when (e.cause0) {
                is androidx.credentials.exceptions.GetCredentialCancellationException ->
                    FSStrings.get(R.string.you_cancelled_the_passkey_check_try)
                is androidx.credentials.exceptions.NoCredentialException ->
                    FSStrings.get(R.string.couldnt_find_your_flagship_passkey_on)
                else -> FSStrings.get(R.string.your_passkey_app_couldnt_check_the)
            }
            is com.flagshipserver.app.keystore.PasskeyRecoveryManager.RecoveryError.ProtocolError ->
                FSStrings.get(R.string.your_passkey_app_sent_an_answer)
        }
    }

    /** True only for the box cert-fingerprint hard-fail — NOT for ordinary
     *  TLS / network failures, so plain offline errors aren't over-alarmed. */
    fun isCertPinMismatch(t: Throwable): Boolean {
        var cur: Throwable? = t
        while (cur != null) {
            if (cur is SSLPeerUnverifiedException &&
                (cur.message?.contains(PIN_MARKER) == true)
            ) {
                return true
            }
            cur = cur.cause
        }
        return false
    }

    private fun classifyStatus(status: Int): Classified = when {
        status >= 500 -> Classified(
            Kind.SERVER_PROBLEM,
            FSStrings.get(R.string.the_server_had_a_temporary_problem),
        )
        status == 408 -> Classified(
            Kind.OFFLINE,
            FSStrings.get(R.string.the_request_timed_out_check_your),
        )
        status >= 400 -> Classified(
            Kind.REQUEST_PROBLEM,
            FSStrings.get(R.string.we_couldnt_complete_that_check_your),
        )
        else -> Classified(
            Kind.UNKNOWN,
            FSStrings.get(R.string.something_went_wrong_please_try_again),
        )
    }

    private fun isOffline(t: Throwable): Boolean {
        var cur: Throwable? = t
        while (cur != null) {
            if (cur is UnknownHostException ||
                cur is SocketTimeoutException ||
                cur is IOException
            ) {
                return true
            }
            cur = cur.cause
        }
        return false
    }
}
