// A failing outbound proxy, in the owner's words (docs/outbound-proxy.md "Failure handling"), and the fallback
// lane's rule: an order the box can't take directly may wait at `.com` for it, never with a password.

package com.flagshipserver.app.core

import com.flagshipserver.app.R

/** What the server page and Home show about a proxy that isn't working. */
data class ProxyAlert(
    /** "failing" (the server is offline until the proxy works or is changed) or "fallback" (connecting directly). */
    val state: String,
    val code: String?,
)

object OutboundProxyCopy {
    /** The sentence for the box's failure [code]; a missing or unknown code reads as unreachable. */
    fun reason(code: String?): String = when (code) {
        "auth" -> FSStrings.get(R.string.proxy_code_auth)
        "refused" -> FSStrings.get(R.string.proxy_code_refused)
        "protocol" -> FSStrings.get(R.string.proxy_code_protocol)
        else -> FSStrings.get(R.string.proxy_code_unreachable)
    }

    /** The server page's loud line, or null when the proxy works (or none is set). */
    fun line(alert: ProxyAlert?): String? = when (alert?.state) {
        "failing" -> FSStrings.get(R.string.proxy_alert_failing, reason(alert.code))
        "fallback" -> FSStrings.get(R.string.proxy_alert_fallback, reason(alert.code))
        else -> null
    }

    /** The box's own status wins when it answered; otherwise what `.com` relays from `/pods`. */
    fun alertOf(status: com.flagshipserver.app.api.OutboundProxyStatus?, pods: com.flagshipserver.app.api.ProxyAlertWire?): ProxyAlert? {
        if (status != null) {
            return if (status.state == "failing" || status.state == "fallback") ProxyAlert(status.state, status.code) else null
        }
        return pods?.let { ProxyAlert(it.state, it.code) }
    }
}

object OutboundProxyLane {
    enum class Decision { ALLOWED, NEEDS_PASSWORD }

    /**
     * Whether [draft] may travel the lane. Flagship never carries a proxy password, so an order whose new password
     * would have to go with it can't: turning the proxy off, a proxy without a password, and the same proxy with
     * the credentials the box already holds can.
     */
    fun decide(draft: BoxProxyDraft): Decision =
        if (draft.kind != "none" && draft.hasCredentials) Decision.NEEDS_PASSWORD else Decision.ALLOWED

    /** A send to the box failed because the box can't be reached (no answer at all), not because it refused. */
    fun isUnreachable(t: Throwable): Boolean = t is java.io.IOException || t.cause is java.io.IOException
}
