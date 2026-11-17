package com.flagshipserver.app.core.voici

import com.flagshipserver.app.calls.VoiciCallRecord
import com.flagshipserver.app.calls.VoiciCallTargetInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Social page's counts and the Calls page's "Who to call" field (docs/social-tabs.md). Mirrors iOS SocialTabsLogicTests. */
class SocialCountsTest {
    private fun r(id: String, dir: String, outcome: String, at: Long) = VoiciCallRecord(id = "$dir|$id", callId = id, direction = dir, outcome = outcome, at = at)

    @Test fun missedCallsCountUntilSeen() {
        val h = listOf(r("1", "in", "missed", 100), r("2", "in", "missed", 300), r("3", "in", "declined", 400), r("4", "out", "no-answer", 500), r("5", "in", "answered", 600))
        assertEquals(2, SocialCounts.unseenMissed(h, 0))
        assertEquals(1, SocialCounts.unseenMissed(h, 200))
        assertEquals(0, SocialCounts.unseenMissed(h, 300))
    }

    @Test fun theTotalIsTheFourCounts() {
        assertEquals(10, SocialCounts(profile = 1, inbox = 2, requests = 3, missedCalls = 4).total)
        assertEquals(0, SocialCounts.of(VoiciMessagesUi(), emptyList(), 0).total)
    }

    @Test fun callTargetTakesAUsernameOrAPageLink() {
        for (input in listOf("alex", " Alex ", "@alex", "voi.ci/alex", "https://voi.ci/alex", "https://voi.ci/alex/", "voi.ci/alex#call=x", "http://www.voi.ci/alex?x=1")) {
            assertEquals(input, "alex", VoiciCallTargetInput.username(input))
        }
        assertEquals("bo-1", VoiciCallTargetInput.username("gym.voi.ci/bo-1", "gym.voi.ci"))
        for (input in listOf("", "   ", "-alex", "al ex", "voi.ci/", "https://example.com/alex", "+1 555 0100", "a".repeat(64))) {
            assertNull(input, VoiciCallTargetInput.username(input))
        }
    }
}
