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
//   - Offline — no network at all (UnknownHost / connect failure / timeout).
//   - ServerProblem — a 5xx from the backend (transient; try again).
//   - RequestProblem — a 4xx other than the cert case (check your connection /
//     the link).
//   - Unknown — anything we can't classify; never leak a raw status/stack to
//     the user.
//
// Raw HTTP status codes and exception messages are intentionally kept OUT of
// the user-facing string (UX-B): a bare "HTTP 503" or "SSLHandshakeException"
// means nothing to a normal person.

package com.flagshipserver.app.core

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
        OFFLINE,
        SERVER_PROBLEM,
        REQUEST_PROBLEM,
        UNKNOWN,
    }

    data class Classified(val kind: Kind, val message: String)

    /** The substring CertPinInterceptor.enforce stamps into the
     *  SSLPeerUnverifiedException it throws on a pin mismatch — the marker that
     *  tells an intercepted-cert failure apart from any other TLS failure. */
    private const val PIN_MARKER = "STK-signed"

    fun classify(t: Throwable): Classified = when {
        isCertPinMismatch(t) -> Classified(
            Kind.CERT_PIN_MISMATCH,
            "This box's certificate doesn't match — someone may be " +
                "intercepting the connection. Reinstall the box or contact " +
                "its admin.",
        )
        t is HttpException -> classifyStatus(t.status)
        t is HasHttpStatus -> classifyStatus(t.httpStatus)
        isOffline(t) -> Classified(
            Kind.OFFLINE,
            "You're offline. Check your connection and try again.",
        )
        else -> Classified(
            Kind.UNKNOWN,
            "Something went wrong. Please try again.",
        )
    }

    /** Convenience: just the human string (UX-B mapping). */
    fun humanize(t: Throwable): String = classify(t).message

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
            "The server had a temporary problem. Please try again in a moment.",
        )
        status == 408 -> Classified(
            Kind.OFFLINE,
            "The request timed out. Check your connection and try again.",
        )
        status >= 400 -> Classified(
            Kind.REQUEST_PROBLEM,
            "We couldn't complete that. Check your connection and try again.",
        )
        else -> Classified(
            Kind.UNKNOWN,
            "Something went wrong. Please try again.",
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
