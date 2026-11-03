// `.com` and the checks answer voi.ci refusals with codes only (docs/voici-and-messages.md §3, §11.4); the app says
// them in the person's language here.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings

object VoiciCopy {
    private val TEXT_CODES = setOf("too-long", "too-short", "control", "bidi", "bom", "edge-invisible", "not-nfc", "surrogate", "not-string")

    fun publishError(code: String?): String = FSStrings.get(
        when (code) {
            null -> R.string.voici_err_network
            "seq-conflict", "conflict", "stale" -> R.string.voici_err_conflict
            "taken-down" -> R.string.voici_err_taken_down
            "rate-limited" -> R.string.voici_err_rate_limited
            "not-sensitive-key", "bad-signature" -> R.string.voici_err_not_admin
            "bad-piece", "missing-piece", "too-large", "malformed", "wrong-page" -> R.string.voici_err_bad_page
            "banned" -> R.string.voici_err_banned_page
            in TEXT_CODES -> R.string.voici_err_text
            else -> R.string.voici_err_network
        },
    )

    fun sendError(code: String?): String = FSStrings.get(
        when (code) {
            in TEXT_CODES -> R.string.voici_err_text
            "rate-limited" -> R.string.voici_err_rate_limited
            "awaiting-reply" -> R.string.voici_err_awaiting_reply
            "sign-out-failed" -> R.string.voici_err_sign_out
            else -> R.string.voici_err_network
        },
    )

    fun signInRefusal(code: String, retryAfterSec: Long?): String = when (code) {
        "first-contact-limit" -> retryAfterSec?.takeIf { it >= 3600 }?.let { FSStrings.get(R.string.voici_err_first_contact_hours, ((it + 1799) / 3600).toInt()) }
            ?: FSStrings.get(R.string.voici_err_first_contact)
        "device-limit" -> FSStrings.get(R.string.voici_err_device_limit)
        "banned" -> FSStrings.get(R.string.voici_err_banned)
        "unattested-too-new" -> FSStrings.get(R.string.voici_err_too_new)
        "not-accepting" -> FSStrings.get(R.string.voici_err_not_accepting)
        "page-unchecked", "not-found" -> FSStrings.get(R.string.voici_err_unchecked)
        "expired" -> FSStrings.get(R.string.voici_err_expired)
        "malformed" -> FSStrings.get(R.string.voici_err_bad_link)
        "bad-attestation" -> FSStrings.get(R.string.voici_err_bad_answer)
        "rate-limited" -> FSStrings.get(R.string.voici_err_rate_limited)
        else -> FSStrings.get(R.string.voici_err_network)
    }

    /** "Visitor 4F3A" (§6.2): the generated name, never text the visitor chose. */
    fun visitorName(pseudonymPub: String): String = FSStrings.get(R.string.voici_visitor_name, VoiciText.voiciPseudonymCode(pseudonymPub))
}
