// Calls and social entries on the Activity tab (docs/activity-social.md). Built on this device each time Activity
// draws, from what the app already holds: the call history, the conversations and the published page. Nothing is
// stored or sent for it, so deleting a conversation (which drops its messages, missed calls and call records on every
// device) removes its entries too. Mirrors iOS SocialActivity.swift and the webapp's lib/socialActivity.js (parity row
// activity-social).

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.R
import com.flagshipserver.app.calls.VoiciCallRecord
import com.flagshipserver.app.core.FSStrings

data class SocialActivityEntry(
    val id: String,
    /** "call.missed", "call.declined", "call.answered", "call.placed", "conversation.new", "conversation.request",
     *  "page.published", "page.updated" or "post.published". Comments and reactions are not built yet
     *  (docs/social-tab.md §3.3): when they are, "comment.new" and "reaction.new" join here. */
    val kind: String,
    val at: Long,
    /** The other side's name (nickname, visitor name or a page's username); "" for the page. */
    val name: String = "",
    /** A post's first line. */
    val snippet: String? = null,
    val video: Boolean = false,
    /** What a tap opens: [SocialTarget]. */
    val target: SocialTarget,
)

sealed interface SocialTarget {
    data class Thread(val conv: String) : SocialTarget
    data object Calls : SocialTarget
    data object Page : SocialTarget
}

object SocialActivity {
    /**
     * Every entry, newest first. [conversations] are the ones Inbox and Requests show (deleted, archived and blocked
     * ones are left out); [published] is the page while it is public (null otherwise), [publishedSeq] its index seq.
     */
    fun build(
        calls: List<VoiciCallRecord>,
        conversations: List<StoredVoiciConversation>,
        isRequest: (StoredVoiciConversation) -> Boolean,
        name: (String) -> String,
        publishedSeq: Long,
        published: VoiciPageState?,
    ): List<SocialActivityEntry> {
        val out = mutableListOf<SocialActivityEntry>()
        val convs = conversations.map { it.conv }.toSet()
        for (r in calls) {
            val kind = when {
                r.direction == "out" -> "call.placed"
                r.outcome == "answered" -> "call.answered"
                r.outcome == "declined" -> "call.declined"
                else -> "call.missed"
            }
            val who = r.peerUsername ?: r.pseudonymPub?.let(name) ?: ""
            val target = if (r.conv != null && r.conv in convs) SocialTarget.Thread(r.conv) else SocialTarget.Calls
            out += SocialActivityEntry(id = "call:${r.direction}|${r.callId.ifEmpty { r.id }}", kind = kind, at = r.at, name = who, video = r.video, target = target)
        }
        for (c in conversations) {
            val ordered = c.ordered
            val first = ordered.firstOrNull { !it.mine } ?: ordered.firstOrNull() ?: continue
            out += SocialActivityEntry(
                id = "conv:${c.conv}", kind = if (isRequest(c)) "conversation.request" else "conversation.new",
                at = first.sentAt, name = name(c.pseudonymPub), target = SocialTarget.Thread(c.conv),
            )
        }
        if (published != null) {
            out += SocialActivityEntry(
                id = "page:$publishedSeq", kind = if (publishedSeq <= 1) "page.published" else "page.updated",
                at = published.issuedAt, target = SocialTarget.Page,
            )
            for (p in published.chunks.flatten()) {
                out += SocialActivityEntry(id = "post:${p.id}", kind = "post.published", at = p.createdAt, snippet = snippet(p.text), target = SocialTarget.Page)
            }
        }
        return out.sortedWith(compareByDescending<SocialActivityEntry> { it.at }.thenBy { it.id })
    }

    /** A post's first line, shortened to 80 characters. */
    fun snippet(text: String): String? {
        val line = text.lineSequence().firstOrNull()?.trim().orEmpty()
        if (line.isEmpty()) return null
        return if (line.codePointCount(0, line.length) > 80) line.substring(0, line.offsetByCodePoints(0, 79)) + "…" else line
    }

    fun title(e: SocialActivityEntry): String = when (e.kind) {
        "call.missed" -> FSStrings.get(R.string.activity_social_call_missed, e.name)
        "call.declined" -> FSStrings.get(R.string.activity_social_call_declined, e.name)
        "call.answered" -> FSStrings.get(R.string.activity_social_call_answered, e.name)
        "call.placed" -> FSStrings.get(R.string.activity_social_call_placed, e.name)
        "conversation.new" -> FSStrings.get(R.string.activity_social_conversation_new, e.name)
        "conversation.request" -> FSStrings.get(R.string.activity_social_conversation_request, e.name)
        "page.published" -> FSStrings.get(R.string.activity_social_page_published)
        "page.updated" -> FSStrings.get(R.string.activity_social_page_updated)
        else -> FSStrings.get(R.string.activity_social_post_published)
    }

    fun detail(e: SocialActivityEntry): String? = when {
        e.kind == "post.published" -> e.snippet
        e.video -> FSStrings.get(R.string.activity_social_video_call)
        else -> null
    }

    /** Missed calls show as warnings. */
    fun isAlert(e: SocialActivityEntry): Boolean = e.kind == "call.missed"
}
