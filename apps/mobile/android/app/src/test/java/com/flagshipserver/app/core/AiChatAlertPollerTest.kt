// #91 — AiChatAlertPoller drains the daemon→phone alert outbox
// (GET /api/phone/alerts), feeds the operations sliver, raises a local
// notification (once per session+tool), and ACKs the range. Kotlin mirror of the
// iOS AiChatAlertPollerTests / webapp webappAiChatAlerts cases — they line up
// one-for-one. The drain client + notifier are injected, so nothing touches
// OkHttp or NotificationManager.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AiChatRequest
import com.flagshipserver.app.api.PhoneAlert
import com.flagshipserver.app.api.PhoneAlertClient
import com.flagshipserver.app.api.PhoneAlertEnvelope
import com.flagshipserver.app.api.PhoneAlertsResponse
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AiChatAlertPollerTest {

    /** A scripted PhoneAlertClient: serves a queued response and records ACKs. */
    private class FakeClient(var response: PhoneAlertsResponse) : PhoneAlertClient {
        var throwOnFetch = false
        val ackedThrough = mutableListOf<Int>()
        val fetchSinceCalls = mutableListOf<Int>()

        override suspend fun fetchAlerts(since: Int): PhoneAlertsResponse {
            fetchSinceCalls.add(since)
            if (throwOnFetch) throw RuntimeException("blip")
            return response
        }
        override suspend fun ackAlerts(throughId: Int) {
            ackedThrough.add(throughId)
        }
    }

    private fun aiChatEnv(id: Int, sessionId: String, request: AiChatRequest, toolUseId: String) =
        PhoneAlertEnvelope(id, 1000 + id, PhoneAlert.AiChatNeedsYou(sessionId, request, toolUseId))

    private fun poller(
        client: FakeClient,
        ops: ActiveOperationsCenter,
        notify: (String, AiChatRequest) -> Unit,
    ) = AiChatAlertPoller(
        operations = ops,
        client = client,
        isActiveGate = { true },
        notify = notify,
        pollIntervalMs = 1,
    )

    @Test fun drainFeedsSliverNotifiesAndAcks() = runTest {
        val ops = ActiveOperationsCenter()
        val client = FakeClient(PhoneAlertsResponse(listOf(aiChatEnv(7, "sess-a", AiChatRequest.TALK_TO_USER, "tool-1")), 1))
        val notified = mutableListOf<Pair<String, AiChatRequest>>()
        val handled = poller(client, ops) { s, r -> notified.add(s to r) }.drainOnce()

        assertEquals(1, handled)
        // The sliver got a build op deep-linking to the chat.
        assertEquals(1, ops.operations.value.size)
        assertEquals("build:sess-a", ops.operations.value.first().id)
        assertEquals(DeepLink.VibeCodeChat("sess-a"), ops.operations.value.first().target)
        // One notification, and the range was ACK'd through id 7.
        assertEquals(1, notified.size)
        assertEquals("sess-a", notified.first().first)
        assertEquals(listOf(7), client.ackedThrough)
        assertEquals(listOf(0), client.fetchSinceCalls)
    }

    @Test fun dedupReDrainSameToolDoesNotReNotify() = runTest {
        val ops = ActiveOperationsCenter()
        val client = FakeClient(PhoneAlertsResponse(listOf(aiChatEnv(1, "sess-a", AiChatRequest.TALK_TO_USER, "tool-1")), 1))
        var notifyCount = 0
        val p = poller(client, ops) { _, _ -> notifyCount += 1 }

        p.drainOnce()
        // Re-serve the SAME pending tool — the dedup set keeps the notifier from
        // firing twice for the same (session, tool).
        p.drainOnce()

        assertEquals(1, notifyCount)
    }

    @Test fun newToolSameSessionReNotifies() = runTest {
        val ops = ActiveOperationsCenter()
        val client = FakeClient(PhoneAlertsResponse(listOf(aiChatEnv(1, "sess-a", AiChatRequest.TALK_TO_USER, "tool-1")), 1))
        val requests = mutableListOf<AiChatRequest>()
        val p = poller(client, ops) { _, r -> requests.add(r) }

        p.drainOnce()
        // The AI emits its NEXT tool in the same session — a genuinely new event.
        client.response = PhoneAlertsResponse(listOf(aiChatEnv(2, "sess-a", AiChatRequest.REQUEST_ENV_VAR, "tool-2")), 1)
        p.drainOnce()

        assertEquals(listOf(AiChatRequest.TALK_TO_USER, AiChatRequest.REQUEST_ENV_VAR), requests)
    }

    @Test fun nonAiChatEnvelopeSkippedButCursorAdvances() = runTest {
        val ops = ActiveOperationsCenter()
        val client = FakeClient(
            PhoneAlertsResponse(
                listOf(
                    PhoneAlertEnvelope(3, 1, PhoneAlert.Other("browser-input-needed")),
                    aiChatEnv(4, "sess-b", AiChatRequest.REQUEST_ENV_VAR, "tool-9"),
                ),
                2,
            ),
        )
        var notified = 0
        val handled = poller(client, ops) { _, _ -> notified += 1 }.drainOnce()

        assertEquals(1, handled)
        assertEquals(1, ops.operations.value.size)
        assertEquals("build:sess-b", ops.operations.value.first().id)
        assertEquals(1, notified)
        // Cursor (and ACK) covers BOTH so this loop doesn't re-drain the
        // browser alert (its own surface handles it).
        assertEquals(listOf(4), client.ackedThrough)
    }

    @Test fun emptyNoAckNoNotify() = runTest {
        val ops = ActiveOperationsCenter()
        val client = FakeClient(PhoneAlertsResponse(emptyList(), 0))
        var notified = 0
        val handled = poller(client, ops) { _, _ -> notified += 1 }.drainOnce()

        assertEquals(0, handled)
        assertTrue(ops.operations.value.isEmpty())
        assertEquals(0, notified)
        assertTrue(client.ackedThrough.isEmpty())
    }

    @Test fun transportErrorHandlesZeroAndReDrainsFromSameCursor() = runTest {
        val ops = ActiveOperationsCenter()
        val client = FakeClient(PhoneAlertsResponse(listOf(aiChatEnv(5, "sess-c", AiChatRequest.TALK_TO_USER, "tool-1")), 1))
        client.throwOnFetch = true
        val p = poller(client, ops) { _, _ -> }

        assertEquals(0, p.drainOnce())
        assertTrue(client.ackedThrough.isEmpty())

        // Recovery: the cursor never advanced (still 0), so the next drain
        // re-fetches from 0 and succeeds.
        client.throwOnFetch = false
        assertEquals(1, p.drainOnce())
        assertEquals(listOf(0, 0), client.fetchSinceCalls)
        assertEquals(listOf(5), client.ackedThrough)
    }

    // ── lenient response parsing ──────────────────────────────────────────

    @Test fun parseExtractsAiChatAndTolueratesUnknownKinds() {
        val body = """
            {"events":[
              {"id":1,"emittedAt":1001,"alert":{"kind":"ai-chat-needs-you","serviceId":"sess-a","request":"requestEnvVar","toolUseId":"t1"}},
              {"id":2,"emittedAt":1002,"alert":{"kind":"some-future-kind","serviceId":"x","whatever":true}}
            ],"size":2}
        """.trimIndent()
        val resp = PhoneAlertsResponse.parse(body)
        assertEquals(2, resp.events.size)
        val first = resp.events[0].alert
        assertTrue(first is PhoneAlert.AiChatNeedsYou)
        first as PhoneAlert.AiChatNeedsYou
        assertEquals("sess-a", first.sessionId)
        assertEquals(AiChatRequest.REQUEST_ENV_VAR, first.request)
        assertEquals("t1", first.toolUseId)
        assertTrue(resp.events[1].alert is PhoneAlert.Other)
        assertEquals("some-future-kind", (resp.events[1].alert as PhoneAlert.Other).kind)
    }

    @Test fun parseEmptyEventsList() {
        val resp = PhoneAlertsResponse.parse("""{"events":[],"size":0}""")
        assertTrue(resp.events.isEmpty())
        assertEquals(0, resp.size)
    }
}
