// Resume build sessions: the box's live vibe-code registry
// (GET /api/llm/sessions) above the past builds. Mirrors the iOS change and
// apps/web/tests/webappVibeSessions.test.ts.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BuildSessionsResponse
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

    @Test fun namesASessionFromItselfThenItsJournalThenItsServiceThenAFallback() {
        val builds = listOf(
            BuildSummary(buildId = "s2", mode = "scratch", serviceId = "alice--notes"),
            BuildSummary(buildId = "s5", mode = "scratch", name = "garden"),
        )
        assertEquals("todo", BuildSessions.name(VibeCodeSessionMeta("s1", 0, "streaming", name = "todo"), builds))
        assertEquals("notes", BuildSessions.name(VibeCodeSessionMeta("s2", 0, "streaming"), builds))
        assertEquals("garden", BuildSessions.name(VibeCodeSessionMeta("s5", 0, "streaming"), builds))
        assertEquals("todo", BuildSessions.name(VibeCodeSessionMeta("s4", 0, "streaming", "alice--todo"), builds))
        assertEquals("Unnamed build", BuildSessions.name(VibeCodeSessionMeta("s3", 0, "streaming"), builds))
    }

    @Test fun decodesTheNameAndVisibilityTheBoxNowKeeps() {
        val r = json.decodeFromString(
            VibeCodeSessionsResponse.serializer(),
            """{"sessions":[{"sessionId":"a","startedAt":1,"status":"streaming","name":"garden","visibility":"just-me"}]}""",
        )
        assertEquals("garden", r.sessions[0].name)
        assertEquals("just-me", r.sessions[0].visibility)
    }

    @Test fun onlyUndeployedSessionsOfferDiscard() {
        assertTrue(VibeCodeSessionMeta("a", 0, "failed", name = "x").canDiscard)
        assertTrue(VibeCodeSessionMeta("a", 0, "streaming").canDiscard)
        assertFalse(VibeCodeSessionMeta("b", 0, "deployed").canDiscard)
    }

    @Test fun theDiscardWarningNamesTheNameItFrees() {
        assertEquals(
            "This stops the AI and deletes what it has written on your server. Its name, \"garden\", becomes free again.",
            BuildSessions.discardMessage(VibeCodeSessionMeta("a", 0, "streaming", name = "garden")),
        )
        assertEquals(
            "This stops the AI and deletes what it has written on your server.",
            BuildSessions.discardMessage(VibeCodeSessionMeta("a", 0, "streaming")),
        )
    }

    @Test fun pastBuildsShowTheirNameAndHowTheyWereMade() {
        val named = BuildSummary(buildId = "a", mode = "scratch", serviceId = "alice--garden", name = "garden", entryCount = 3)
        assertEquals("garden", named.displayName)
        assertEquals("AI chat", named.methodLabel)
        assertEquals("Started today · 3 steps", BuildSessions.pastBuildSubtitle(named, "today"))
        val fromService = BuildSummary(buildId = "b", mode = "git", serviceId = "alice--notes", entryCount = 1)
        assertEquals("notes", fromService.displayName)
        assertEquals("From Git", fromService.methodLabel)
        assertEquals("Started today · 1 step", BuildSessions.pastBuildSubtitle(fromService, "today"))
        val bare = BuildSummary(buildId = "c", mode = "mcp")
        assertEquals("Unnamed build", bare.displayName)
        assertEquals("From your IDE", bare.methodLabel)
    }

    @Test fun discardRemovesTheSessionOrShowsWhyNot() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val discarded = mutableListOf<String>()
        val vm = BuildJournalViewModel(
            client, scope = backgroundScope,
            fetchLiveSessions = { listOf(VibeCodeSessionMeta("a", 2, "streaming"), VibeCodeSessionMeta("b", 1, "failed")) },
            discardSession = { discarded += it },
        )
        vm.loadList().join()
        vm.discard(vm.liveSessions.value.first()).join()
        assertEquals(listOf("a"), discarded)
        assertEquals(listOf("b"), vm.liveSessions.value.map { it.sessionId })
        assertNull(vm.discardError.value)

        val failing = BuildJournalViewModel(
            client, scope = backgroundScope,
            fetchLiveSessions = { listOf(VibeCodeSessionMeta("a", 2, "streaming")) },
            discardSession = { throw com.flagshipserver.app.api.ScreensError.Http(500, "boom") },
        )
        failing.loadList().join()
        failing.discard(failing.liveSessions.value.first()).join()
        assertEquals(listOf("a"), failing.liveSessions.value.map { it.sessionId })
        assertTrue(failing.discardError.value != null)
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

    @Test fun openBuildsAreSeparateAndDiscardable() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply {
            sessionsFixture = BuildSessionsResponse(
                builds = listOf(
                    BuildSummary(buildId = "g1", mode = "git", name = "notes", startedAt = 1, lastAt = 2, entryCount = 3, lastKind = "fitness-check", open = true),
                    BuildSummary(buildId = "g0", mode = "git", name = "old", startedAt = 1, lastAt = 2, entryCount = 5, lastKind = "deployed"),
                ),
            )
        }
        val vm = BuildJournalViewModel(client, scope = backgroundScope)
        vm.loadList().join()
        val builds = (vm.list.value as LoadingState.Loaded).value
        assertEquals(listOf("g1"), BuildSessions.openBuilds(builds, vm.liveSessions.value).map { it.buildId })
        assertEquals(listOf("g0"), BuildSessions.endedBuilds(builds, vm.liveSessions.value).map { it.buildId })
        vm.discard(builds[0]).join()
        assertEquals(listOf("g1"), client.discardCalls)
        assertNull(vm.discardError.value)
        assertEquals(
            "This deletes what was imported or written on your server. Its name, \"notes\", becomes free again.",
            BuildSessions.discardBuildMessage(builds[0]),
        )
    }

    @Test fun decodesAnOpenBuildAndABuildState() {
        val list = json.decodeFromString(
            BuildSessionsResponse.serializer(),
            """{"builds":[{"buildId":"g1","mode":"git","name":"notes","startedAt":1,"lastAt":2,"entryCount":3,"lastKind":"x","open":true}]}""",
        )
        assertEquals(true, list.builds[0].open)
        val st = json.decodeFromString(
            com.flagshipserver.app.api.BuildStateResponse.serializer(),
            """{"state":{"buildId":"g1","mode":"git","serverFqdn":"h","createdAt":1,"name":"notes","adapt":{"status":"running","startedAt":5}},"files":["a.ts"]}""",
        )
        assertEquals("running", st.state.adapt?.status)
        assertEquals("notes", st.state.name)
        assertEquals(listOf("a.ts"), st.files)
    }
}
