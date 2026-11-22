// `.com` and the checks answer voi.ci refusals with codes only (docs/voici-and-messages.md §3, §11.4); the app says
// them in the person's language here.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings

object VoiciCopy {
    /** Why a picked photo could not become the page photo. */
    fun photoProblem(f: VoiciImageFailure?): String = FSStrings.get(
        when (f) {
            VoiciImageFailure.UNREADABLE -> R.string.voici_photo_unreadable
            VoiciImageFailure.TOO_DETAILED -> R.string.voici_photo_too_detailed
            VoiciImageFailure.ENCODE_FAILED, null -> R.string.voici_photo_encode_failed
        },
    )

    private val TEXT_CODES = setOf("too-long", "too-short", "control", "bidi", "bom", "edge-invisible", "not-nfc", "surrogate", "not-string")

    /** Turning "Answer calls while Flagship is locked" on or off failed. */
    fun callKeyError(code: String): String = when (code) {
        "locked", "not-found" -> FSStrings.get(R.string.voici_calls_answer_locked_unlock)
        else -> publishError(code)
    }

    fun publishError(code: String?): String = FSStrings.get(
        when (code) {
            null -> R.string.voici_err_network
            "seq-conflict", "conflict", "stale" -> R.string.voici_err_conflict
            "taken-down" -> R.string.voici_err_taken_down
            "rate-limited" -> R.string.voici_err_rate_limited
            "not-sensitive-key", "bad-signature" -> R.string.voici_err_not_admin
            "bad-piece", "missing-piece", "too-large", "malformed", "wrong-page" -> R.string.voici_err_bad_page
            "banned" -> R.string.voici_err_banned_page
            "too-many-chunks" -> R.string.voici_err_too_many_chunks
            in TEXT_CODES -> R.string.voici_err_text
            else -> R.string.voici_err_network
        },
    )

    /** "Remove my page" refused or failed (§3.3). */
    fun removeError(code: String?): String = when (code) {
        "not-sensitive-key", "wrong-signer", "bad-signature" -> FSStrings.get(R.string.voici_admin_only_remove)
        "taken-down", "rate-limited", "banned" -> publishError(code)
        "remove-failed", "seq-conflict", "wrong-page", "stale" -> FSStrings.get(R.string.voici_remove_failed)
        else -> FSStrings.get(R.string.voici_err_network)
    }

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
    fun visitorName(pseudonymPub: String): String =
        // An anonymous caller (an "anyone" page) has a browser key, not a pseudonym: no generated name exists for it.
        if (!WebEnvelopes.isLowerHex(pseudonymPub, 32)) FSStrings.get(R.string.voici_anonymous_caller)
        else FSStrings.get(R.string.voici_visitor_name, VoiciText.voiciPseudonymCode(pseudonymPub))

    // ── calling from the app (docs/voici-calls.md "Calling from the app") ──

    /** The string id for a call history row's outcome. */
    fun callOutcome(r: com.flagshipserver.app.calls.VoiciCallRecord): Int = when (r.outcome) {
        "missed" -> if (r.video) R.string.voici_calls_missed_video else R.string.voici_calls_missed
        "declined" -> R.string.voici_calls_history_declined
        "no-answer" -> R.string.voici_calls_history_no_answer
        "cancelled" -> R.string.voici_calls_history_cancelled
        "failed" -> R.string.voici_calls_history_failed
        "browser" -> R.string.voici_calls_history_browser
        else -> if (r.direction == "out") R.string.voici_calls_history_outgoing else R.string.voici_calls_history_incoming
    }

    /** Who a history row is with: the page called, or a visitor of this account's page by their nickname or code. */
    fun callPeer(r: com.flagshipserver.app.calls.VoiciCallRecord, nicknames: Map<String, String>): String = when {
        r.peerUsername != null -> FSStrings.get(R.string.voici_calls_peer_page, r.peerUsername)
        r.pseudonymPub != null -> nicknames[r.pseudonymPub] ?: visitorName(r.pseudonymPub)
        else -> FSStrings.get(R.string.voici_call_someone)
    }

    /** The status line of a call this app is placing to [name]. */
    fun outgoingStatus(s: com.flagshipserver.app.calls.VoiciOutgoingState, name: String): String = when (s) {
        com.flagshipserver.app.calls.VoiciOutgoingState.Preparing -> FSStrings.get(R.string.voici_call_calling, name)
        com.flagshipserver.app.calls.VoiciOutgoingState.Ringing -> FSStrings.get(R.string.voici_call_ringing)
        com.flagshipserver.app.calls.VoiciOutgoingState.Connecting -> FSStrings.get(R.string.voici_call_connecting)
        is com.flagshipserver.app.calls.VoiciOutgoingState.Connected -> FSStrings.get(R.string.voici_call_connected)
        com.flagshipserver.app.calls.VoiciOutgoingState.Browser -> FSStrings.get(R.string.voici_call_in_browser, name)
        is com.flagshipserver.app.calls.VoiciOutgoingState.Ended -> when (s.reason) {
            "no-answer" -> FSStrings.get(R.string.voici_call_no_answer)
            "decline" -> FSStrings.get(R.string.voici_call_declined)
            "busy" -> FSStrings.get(R.string.voici_call_busy)
            "limit" -> FSStrings.get(R.string.voici_call_limit)
            "failed" -> FSStrings.get(R.string.voici_call_failed)
            else -> FSStrings.get(R.string.voici_call_ended)
        }
        is com.flagshipserver.app.calls.VoiciOutgoingState.Failed -> callFailure(s.code)
    }

    /** A refusal or failure of a call this app placed (`.com`'s codes and the app's own). */
    fun callFailure(code: String): String = when (code) {
        "calls-off" -> FSStrings.get(R.string.voici_call_off)
        "not-allowed" -> FSStrings.get(R.string.voici_call_not_allowed)
        "busy" -> FSStrings.get(R.string.voici_call_busy)
        "rate-limited" -> FSStrings.get(R.string.voici_call_rate_limited)
        "locked" -> FSStrings.get(R.string.voici_calls_answer_locked_unlock)
        "browser-unreachable" -> FSStrings.get(R.string.voici_call_no_browser)
        "ring-back-required" -> FSStrings.get(R.string.voici_call_ring_back_required)
        "first-contact-limit", "device-limit", "banned", "unattested-too-new" -> signInRefusal(code, null)
        else -> FSStrings.get(R.string.voici_call_failed)
    }
}
