// "Your watch is waiting": set when the watch's Approve reached a phone whose
// app session hasn't used biometrics yet, so the app, once in front, can ask
// the owner to unlock it. The prompt only asks; the biometric opens from the
// owner's own tap, never from the watch's request, and the approval stays the
// delegate-key signature the watch's next Approve produces. The Kotlin twin of
// iOS's WatchApprovalPrompt.

package com.flagshipserver.app.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class WatchApprovalPrompt(private val now: () -> Long = { System.currentTimeMillis() }) {
    data class Waiting(
        /** The box the watch asked about. */
        val serverFqdn: String?,
        val at: Long,
    )

    private val _waiting = MutableStateFlow<Waiting?>(null)
    val waiting: StateFlow<Waiting?> = _waiting.asStateFlow()

    fun watchIsWaiting(serverFqdn: String?) {
        _waiting.value = Waiting(serverFqdn?.takeIf { it.isNotBlank() }, now())
    }

    /** The ask still worth showing, or null once answered or expired. */
    fun current(): Waiting? = _waiting.value?.takeIf { now() - it.at < LIFETIME_MS }

    fun clear() {
        _waiting.value = null
    }

    /** Ask in the app only while it is in front, past its lock screen and
     *  without this session's biometric. */
    fun shouldAsk(inFront: Boolean, appUnlocked: Boolean, sessionUnlocked: Boolean): Boolean =
        inFront && appUnlocked && !sessionUnlocked && current() != null

    companion object {
        /** A boot request lives a few minutes; an older ask isn't worth raising. */
        const val LIFETIME_MS = 5 * 60 * 1000L

        val shared = WatchApprovalPrompt()

        const val TITLE = "Your watch is waiting"
        const val AFTER_UNLOCK = "Unlocked. Tap Approve on your watch again."
        const val LOCK_SCREEN_NOTE =
            "Your watch is waiting to approve a server's start-up. Unlock, then tap Approve on the watch again."

        fun message(serverName: String?): String {
            val what = serverName?.let { "$it's start-up" } ?: "a server's start-up"
            return "Your watch asked to approve $what. Unlock Flagship once so it can, then tap Approve on the watch again."
        }
    }
}
