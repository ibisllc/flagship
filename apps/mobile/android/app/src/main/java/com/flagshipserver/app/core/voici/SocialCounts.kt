// The red counts on the Social page (docs/social-tabs.md): Profile, Inbox, Requests, the floating call button, and
// their total on the Social tab in the bottom bar. Every count comes from what the app already holds; the "seen"
// markers (calls, profile) are this device's own, in its encrypted local copy, never sent anywhere. Mirrors iOS
// SocialBadges.swift.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.calls.VoiciCallRecord

data class SocialCounts(
    /** New comments and reactions on the owner's posts. Not built yet (docs/social-tab.md §3.3), so 0 for now. */
    val profile: Int = 0,
    /** Conversations with an unread message (requests left out: they have their own count), and replies waiting on pages this account wrote to. */
    val inbox: Int = 0,
    /** Message requests waiting for a reply or an accept. */
    val requests: Int = 0,
    /** Missed calls newer than the last time the Calls page was open. */
    val missedCalls: Int = 0,
) {
    val total: Int get() = profile + inbox + requests + missedCalls

    companion object {
        fun of(ui: VoiciMessagesUi, history: List<VoiciCallRecord>, callsSeenAt: Long, replies: Int = 0): SocialCounts = SocialCounts(
            inbox = ui.accepted.count { ui.unread(it) } + replies,
            requests = ui.requests.size,
            missedCalls = unseenMissed(history, callsSeenAt),
        )

        fun unseenMissed(history: List<VoiciCallRecord>, seenAt: Long): Int =
            history.count { it.direction == "in" && it.outcome == "missed" && it.at > seenAt }
    }
}
