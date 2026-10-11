// Resume build sessions: the box's live vibe-code registry
// (GET /api/llm/sessions) above the past builds. Mirrors the iOS change and
// apps/web/tests/webappVibeSessions.test.ts.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BuildSummary
import com.flagshipserver.app.api.MockBuildClient
import com.flagshipserver.app.api.VibeCodeSessionMeta
import com.flagshipserver.app.api.VibeCodeSessionsResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildSessionsTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Test fun decodesTheRegistryIgnoringOtherFields() {
        val wire = """{"sessions":[
            {"sessionId":"s1","startedAt":1760000000000,"status":"streaming","serviceId":"alice--todo","url":"https://x","updatedAt":5,"appId":"a"},
            {"sessionId":"s2","startedAt":1760000001000,"status":"deployed"}
        ]}"""
        val r = json.decodeFromString(VibeCodeSessionsResponse.serializer(), wire)
        assertEquals(2, r.sessions.size)
        assertEquals("alice--todo", r.sessions[0].serviceId)
        assertEquals(1760000000000L, r.sessions[0].startedAt)
        assertNull(r.sessions[1].serviceId)
        assertNull(r.sessions[1].url)
    }

    @Test fun activeMeansWorkingOrWaitingOnTheOwner() {
        for (s in listOf("streaming", "awaiting-tool-response", "ready-to-deploy", "deploying")) {
            assertTrue(s, VibeCodeSessionMeta(sessionId = "x", status = s).isActive)
        }
        for (s in listOf("deployed", "failed", "cancelled", "weird")) {
            assertFalse(s, VibeCodeSessionMeta(sessionId = "x", status = s).isActive)
        }
    }

    @Test fun labelsEachStatusInPlainWords() {
        assertEquals("AI is working", BuildSessions.label("streaming"))
        assertEquals("Waiting for you", BuildSessions.label("awaiting-tool-response"))
        assertEquals("Ready to deploy", BuildSessions.label("ready-to-deploy"))
        assertEquals("Deploying", BuildSessions.label("deploying"))
        assertEquals("Deployed", BuildSessions.label("deployed"))
        assertEquals("Cancelled", BuildSessions.label("cancelled"))
        assertEquals("Stopped", BuildSessions.label("failed"))
    }

    @Test fun pastBuildsLeaveOutOpenSessions() {
        val builds = listOf(
            BuildSummary(buildId = "s1", mode = "scratch"),
            BuildSummary(buildId = "g1", mode = "git"),
        )
        val ended = BuildSessions.endedBuilds(builds, listOf(VibeCodeSessionMeta(sessionId = "s1", status = "streaming")))
        assertEquals(listOf("g1"), ended.map { it.buildId })
    }

    @Test fun namesASessionFromItselfThenItsJournalThenAFallback() {
        val builds = listOf(BuildSummary(buildId = "s2", mode = "scratch", serviceId = "alice--notes"))
        assertEquals("alice--todo", BuildSessions.name(VibeCodeSessionMeta("s1", 0, "streaming", "alice--todo"), builds))
        assertEquals("alice--notes", BuildSessions.name(VibeCodeSessionMeta("s2", 0, "streaming"), builds))
        assertEquals("AI build", BuildSessions.name(VibeCodeSessionMeta("s3", 0, "streaming"), builds))
    }

    @Test fun listLoadsSessionsNewestFirst_andAFailingRegistryReadsAsNone() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val vm = BuildJournalViewModel(client, scope = backgroundScope, fetchLiveSessions = {
            listOf(VibeCodeSessionMeta("old", 1, "deployed"), VibeCodeSessionMeta("new", 2, "streaming"))
        })
        vm.loadList().join()
        assertEquals(listOf("new", "old"), vm.liveSessions.value.map { it.sessionId })
        assertTrue(vm.list.value is LoadingState.Loaded)

        val failing = BuildJournalViewModel(client, scope = backgroundScope, fetchLiveSessions = { error("down") })
        failing.loadList().join()
        assertTrue(failing.liveSessions.value.isEmpty())
        assertTrue(failing.list.value is LoadingState.Loaded)
    }
}
