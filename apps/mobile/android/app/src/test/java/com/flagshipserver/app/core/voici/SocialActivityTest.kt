package com.flagshipserver.app.core.voici

import com.flagshipserver.app.calls.VoiciCallRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Calls and social entries on Activity (docs/activity-social.md). Mirrors iOS SocialActivityTests and the webapp's webappSocialActivity.test.ts. */
class SocialActivityTest {
    private fun msg(id: String, mine: Boolean, at: Long) = StoredVoiciMessage(msgId = id, from = "p", seq = 1, sentAt = at, text = id, mine = mine)
    private fun conv(id: String, pub: String, vararg m: StoredVoiciMessage) = StoredVoiciConversation(conv = id, pageId = "pg", pseudonymPub = pub, threadPub = "", messages = m.toList())
    private fun page(issuedAt: Long, vararg posts: VoiciPost) =
        VoiciPageState(VoiciProfile("Alice", "", null, "classic", emptyList()), 1, listOf(posts.toList()), issuedAt)

    private fun build(
        calls: List<VoiciCallRecord> = emptyList(),
        conversations: List<StoredVoiciConversation> = emptyList(),
        requests: Set<String> = emptySet(),
        seq: Long = 0,
        published: VoiciPageState? = null,
    ) = SocialActivity.build(calls, conversations, { it.conv in requests }, { "Name $it" }, seq, published)

    @Test fun callKindsFollowDirectionAndOutcome() {
        val calls = listOf(
            VoiciCallRecord(id = "in|1", callId = "1", direction = "in", outcome = "missed", conv = "c1", pseudonymPub = "p1", at = 10),
            VoiciCallRecord(id = "in|2", callId = "2", direction = "in", outcome = "answered", conv = "gone", pseudonymPub = "p2", media = "audio,video", at = 20),
            VoiciCallRecord(id = "in|3", callId = "3", direction = "in", outcome = "declined", conv = "c1", pseudonymPub = "p1", at = 30),
            VoiciCallRecord(id = "out|4", callId = "4", direction = "out", outcome = "no-answer", peerUsername = "bob", peerPageId = "x", at = 40),
        )
        val out = build(calls = calls, conversations = listOf(conv("c1", "p1", msg("m", false, 5))))
        val by = out.associateBy { it.id }
        assertEquals("call.missed", by["call:in|1"]?.kind)
        assertEquals(SocialTarget.Thread("c1"), by["call:in|1"]?.target)
        assertEquals("Name p1", by["call:in|1"]?.name)
        assertEquals("call.answered", by["call:in|2"]?.kind)
        assertTrue(by["call:in|2"]!!.video)
        // Its conversation was deleted: the call opens the Calls page.
        assertEquals(SocialTarget.Calls, by["call:in|2"]?.target)
        assertEquals("call.declined", by["call:in|3"]?.kind)
        assertEquals("call.placed", by["call:out|4"]?.kind)
        assertEquals("bob", by["call:out|4"]?.name)
        assertEquals(listOf(40L, 30L, 20L, 10L, 5L), out.map { it.at })
    }

    @Test fun conversationsAreNewOrRequestsAtTheirFirstMessage() {
        val accepted = conv("a", "pa", msg("1", false, 100), msg("2", true, 200))
        val request = conv("r", "pr", msg("3", false, 300))
        val out = build(conversations = listOf(accepted, request), requests = setOf("r"))
        assertEquals(listOf("conversation.request", "conversation.new"), out.map { it.kind })
        assertEquals(listOf(300L, 100L), out.map { it.at })
        assertEquals(SocialTarget.Thread("a"), out.last().target)
    }

    @Test fun deletingAConversationRemovesItsEntries() {
        val c = conv("c1", "p1", msg("m", false, 5))
        val call = VoiciCallRecord(id = "in|1", callId = "1", direction = "in", outcome = "missed", conv = "c1", pseudonymPub = "p1", at = 10)
        assertEquals(2, build(calls = listOf(call), conversations = listOf(c)).size)
        // After a delete the conversation and its call records are gone from what the device holds: nothing is left.
        assertTrue(build().isEmpty())
    }

    @Test fun pageEntriesOnlyWhilePublic() {
        assertTrue(build(seq = 3, published = null).isEmpty())
        val first = build(seq = 1, published = page(50, VoiciPost("p", 49, null, "Hello.\nSecond line", emptyList())))
        assertEquals(listOf("page.published", "post.published"), first.map { it.kind })
        assertEquals("Hello.", first.last().snippet)
        assertEquals(listOf<SocialTarget>(SocialTarget.Page, SocialTarget.Page), first.map { it.target })
        assertEquals(listOf("page.updated"), build(seq = 4, published = page(50)).map { it.kind })
    }

    @Test fun aLongPostIsShortened() {
        assertEquals(80, SocialActivity.snippet("x".repeat(200))!!.length)
        assertNull(SocialActivity.snippet("  \n"))
    }
}

/** An answered call's length (owner, 2026-11-16): DateUtils.formatElapsedTime needs the framework, so Robolectric. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], qualifiers = "en-rUS")
class SocialActivityCallLengthTest {
    @Test fun answeredCallsShowTheirLength() {
        val calls = listOf(
            VoiciCallRecord(id = "in|1", callId = "1", direction = "in", outcome = "answered", conv = "c", pseudonymPub = "p", at = 10, durationMs = 272_400),
            VoiciCallRecord(id = "out|2", callId = "2", direction = "out", outcome = "answered", peerUsername = "bob", peerPageId = "x", media = "audio,video", at = 20, durationMs = 3_725_000),
            VoiciCallRecord(id = "in|3", callId = "3", direction = "in", outcome = "missed", conv = "c", pseudonymPub = "p", at = 30, durationMs = 9_000),
            VoiciCallRecord(id = "in|4", callId = "4", direction = "in", outcome = "answered", conv = "c", pseudonymPub = "p", at = 40),
        )
        val by = SocialActivity.build(calls, emptyList(), { false }, { it }, 0, null).associateBy { it.id }
        assertEquals(272_400L, by["call:in|1"]?.durationMs)
        assertEquals("Answered · 4:32", SocialActivity.detail(by["call:in|1"]!!))
        assertEquals("Video call · 1:02:05", SocialActivity.detail(by["call:out|2"]!!))
        // Only an answered call has a length; one with none recorded shows no detail.
        assertNull(by["call:in|3"]?.durationMs)
        assertNull(SocialActivity.detail(by["call:in|4"]!!))
    }

    @Test fun callLengthIsTheLocalesClock() {
        assertEquals("0:05", SocialActivity.callLength(5_000))
        assertEquals("1:05", SocialActivity.callLength(65_000))
        assertEquals("4:32", SocialActivity.callLength(272_999))
        assertEquals("12:34", SocialActivity.callLength(754_000))
        assertEquals("1:02:05", SocialActivity.callLength(3_725_000))
        assertNull(SocialActivity.callLength(0))
    }
}
