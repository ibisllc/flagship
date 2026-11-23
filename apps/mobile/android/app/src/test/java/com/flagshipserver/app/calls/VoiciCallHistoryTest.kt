// The device-local call history (docs/voici-calls.md "Calling from the app"): outcomes from how a call ended, the
// merge with the missed calls `.com` holds (one row per call, newest first), and the cap.

package com.flagshipserver.app.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiciCallHistoryTest {
    private fun rec(callId: String, at: Long, direction: String = "out", outcome: String = "answered", user: String? = "alice") =
        VoiciCallRecord(id = "$callId-$direction", callId = callId, direction = direction, outcome = outcome, peerUsername = user, peerPageId = user?.let { "ab".repeat(16) }, at = at)

    @Test fun outcomesFollowHowTheCallEnded() {
        assertEquals("answered", VoiciCallHistory.outgoingOutcome("hangup", connected = true))
        assertEquals("declined", VoiciCallHistory.outgoingOutcome("decline", false))
        assertEquals("cancelled", VoiciCallHistory.outgoingOutcome("cancel", false))
        assertEquals("no-answer", VoiciCallHistory.outgoingOutcome("no-answer", false))
        assertEquals("no-answer", VoiciCallHistory.outgoingOutcome("busy", false))
        assertEquals("failed", VoiciCallHistory.outgoingOutcome("failed", false))
        assertEquals("answered", VoiciCallHistory.incomingOutcome("hangup", true))
        assertEquals("declined", VoiciCallHistory.incomingOutcome("decline", false))
        assertEquals("missed", VoiciCallHistory.incomingOutcome("no-answer", false))
        assertNull("another device answered: not this device's call", VoiciCallHistory.incomingOutcome("answered-elsewhere", false))
    }

    @Test fun mergesMissedCallsOnceNewestFirst() {
        val local = listOf(rec("c1", 100), rec("c2", 300, direction = "in", outcome = "declined", user = null).copy(conv = "cv", pseudonymPub = "pp"))
        val missed = listOf(
            VoiciMissedCallRow("c2", "cv", "pp", "decline", 290, false),
            VoiciMissedCallRow("c3", "cv3", "p3", "no-answer", 200, true),
        )
        val out = VoiciCallHistory.merge(local, missed)
        assertEquals(listOf("c2", "c3", "c1"), out.map { it.callId })
        assertEquals("declined", out[0].outcome)
        val m = out[1]
        assertEquals(listOf("in", "missed", "audio,video", "cv3", "p3"), listOf(m.direction, m.outcome, m.media, m.conv, m.pseudonymPub))
        assertFalse("a visitor of this page is rung back from their thread, not dialled from the history", m.callable)
        assertTrue(out[2].callable)
    }

    @Test fun addReplacesTheSameCallAndKeepsTheNewest() {
        var list = emptyList<VoiciCallRecord>()
        for (i in 0 until VoiciCallHistory.MAX_RECORDS + 5) list = VoiciCallHistory.add(list, rec("c$i", i.toLong()))
        assertEquals(VoiciCallHistory.MAX_RECORDS, list.size)
        assertEquals("c${VoiciCallHistory.MAX_RECORDS + 4}", list.first().callId)
        list = VoiciCallHistory.add(list, rec("c${VoiciCallHistory.MAX_RECORDS + 4}", 10_000, outcome = "failed"))
        assertEquals(VoiciCallHistory.MAX_RECORDS, list.size)
        assertEquals("failed", list.first().outcome)
    }

    private val pseudonym = "aa".repeat(32)
    private val thread = "bb".repeat(32)
    private fun visitorCall(threadPub: String? = thread, pseudonymPub: String = pseudonym, direction: String = "in") =
        VoiciCallRecord(id = "v-$direction", callId = "v", direction = direction, outcome = "missed", conv = "cv", pseudonymPub = pseudonymPub, at = 1, threadPub = threadPub)

    @Test fun aCallerWhoNeverWroteGetsCallBackWhileAllowed() {
        assertTrue(visitorCall().offersCallBack(hasThread = false, ringBackOff = emptySet(), blocked = emptySet(), callsOn = true))
    }

    @Test fun noCallBackWhenRefusedBlockedThreadedAnonymousOrWithoutThreadKey() {
        val r = visitorCall()
        assertFalse("`.com` refused a ring to it", r.offersCallBack(false, setOf("cv"), emptySet(), true))
        assertFalse("blocked", r.offersCallBack(false, emptySet(), setOf(pseudonym), true))
        assertFalse("calls off", r.offersCallBack(false, emptySet(), emptySet(), false))
        assertFalse("a thread exists: its Call rings back", r.offersCallBack(true, emptySet(), emptySet(), true))
        assertFalse("anonymous (a browser key)", visitorCall(pseudonymPub = "04" + "11".repeat(64)).offersCallBack(false, emptySet(), emptySet(), true))
        assertFalse("an older build's record", visitorCall(threadPub = null).offersCallBack(false, emptySet(), emptySet(), true))
        assertFalse("outgoing", visitorCall(direction = "out").offersCallBack(false, emptySet(), emptySet(), true))
    }

    @Test fun aMissedCallKeepsTheCallersThreadKey() {
        val out = VoiciCallHistory.merge(emptyList(), listOf(VoiciMissedCallRow("m1", "cv", pseudonym, "no-answer", 5, false, thread), VoiciMissedCallRow("m2", "cv2", "pp", "no-answer", 4, false)))
        assertEquals(thread, out[0].threadPub)
        assertNull(out[1].threadPub)
    }

    @Test fun aRecordFromAnOlderBuildDecodesWithoutAThreadKey() {
        val r = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString(VoiciCallRecord.serializer(), """{"id":"c-in","callId":"c","direction":"in","outcome":"missed","at":1}""")
        assertNull(r.threadPub)
    }
}
