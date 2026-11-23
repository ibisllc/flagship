// The call history on the Social page (docs/voici-calls.md "Calling from the app"): calls this device placed or
// answered, kept only on this device (in its sealed Messages vault, gone at sign-out), merged with the missed calls
// `.com` holds sealed to the inbox key. No server keeps a log of who called whom.

package com.flagshipserver.app.calls

import kotlinx.serialization.Serializable

/**
 * One call on this device. [direction] "in" or "out"; [outcome] answered, missed, declined, no-answer, cancelled,
 * failed or browser (handed to a voi.ci tab). The other side is a page ([peerUsername], [peerPageId]) when this
 * account called it, or a visitor of this account's page ([conv], [pseudonymPub]).
 */
@Serializable
data class VoiciCallRecord(
    val id: String,
    val callId: String,
    val direction: String,
    val outcome: String,
    val peerUsername: String? = null,
    val peerPageId: String? = null,
    val conv: String? = null,
    val pseudonymPub: String? = null,
    val media: String = "audio",
    val at: Long,
    val durationMs: Long = 0,
    /**
     * A visitor's thread key for this conversation, from the call's signed request: lets the history ring back a
     * caller who never wrote (no thread here). Null for pages, anonymous callers and records from older builds.
     */
    val threadPub: String? = null,
) {
    val video: Boolean get() = media == "audio,video"
    /** A page this account can call again from the history (a visitor is rung back from their thread, or with Call back). */
    val callable: Boolean get() = peerUsername != null && peerPageId != null

    /**
     * Whether this row offers Call back: an incoming call from a visitor (not anonymous: a pseudonym, 64 hex) who has
     * no thread here, whose call left their thread key, while their conversation still allows call-backs (not in
     * [ringBackOff], not [blocked], calls on).
     */
    fun offersCallBack(hasThread: Boolean, ringBackOff: Set<String>, blocked: Set<String>, callsOn: Boolean): Boolean =
        direction == "in" && conv != null && pseudonymPub != null && pseudonymPub.length == 64 && !hasThread &&
            !threadPub.isNullOrEmpty() && callsOn && conv !in ringBackOff && pseudonymPub !in blocked
}

object VoiciCallHistory {
    /** How many records a device keeps (oldest dropped first). */
    const val MAX_RECORDS = 200

    /** The outcome of a call this device placed, from the room's end reason. */
    fun outgoingOutcome(reason: String, connected: Boolean): String = when {
        connected -> "answered"
        reason == "decline" -> "declined"
        reason == "cancel" -> "cancelled"
        reason == "no-answer" || reason == "busy" -> "no-answer"
        else -> "failed"
    }

    /** The outcome of a call that rang here, from how it ended. Null when another of the account's devices took it. */
    fun incomingOutcome(reason: String, connected: Boolean): String? = when {
        connected -> "answered"
        reason == "answered-elsewhere" -> null
        reason == "decline" -> "declined"
        else -> "missed"
    }

    /** Adds [r] (replacing a record of the same call and direction) and keeps the newest [MAX_RECORDS]. */
    fun add(list: List<VoiciCallRecord>, r: VoiciCallRecord): List<VoiciCallRecord> =
        (list.filterNot { it.callId.isNotEmpty() && it.callId == r.callId && it.direction == r.direction } + r)
            .sortedByDescending { it.at }
            .take(MAX_RECORDS)

    /**
     * The history to show: this device's records and the missed calls from `.com`, newest first. A missed call this
     * device also recorded (it rang here) shows once, as recorded.
     */
    fun merge(local: List<VoiciCallRecord>, missed: List<VoiciMissedCallRow>): List<VoiciCallRecord> {
        val seen = local.filter { it.direction == "in" }.map { it.callId }.toSet()
        val fromServer = missed.filter { it.callId !in seen }.map {
            VoiciCallRecord(
                id = "missed-${it.callId}", callId = it.callId, direction = "in", outcome = "missed",
                conv = it.conv, pseudonymPub = it.pseudonymPub, media = if (it.video) "audio,video" else "audio", at = it.ringingAt,
                threadPub = it.threadPub.ifEmpty { null },
            )
        }
        return (local + fromServer).sortedWith(compareByDescending<VoiciCallRecord> { it.at }.thenBy { it.id })
    }
}
