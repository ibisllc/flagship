// Wire-format parity for the "build a service" modes. Decodes the exact
// JSON the daemon emits (per docs/build-modes.md + buildModesHttp.ts) into
// the Kotlin models, then asserts the MockBuildClient produces shapes that
// round-trip identically — the hard repo rule that the Mock must match the
// live wire format. Mirrors the iOS BuildClient wire tests.

package com.flagshipserver.app.api

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BuildClientWireTest {

    // Same lenient config the live client uses.
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    // ---------- decode the documented daemon JSON ----------------------

    @Test fun decode_gitImport_fit() {
        val wire = """{"buildId":"bld-1","fit":true,"reason":"found flagship.app.json","manifestName":"my-app","fileCount":14}"""
        val r = json.decodeFromString(BuildGitResponse.serializer(), wire)
        assertEquals("bld-1", r.buildId)
        assertTrue(r.fit)
        assertEquals("my-app", r.manifestName)
        assertEquals(14, r.fileCount)
    }

    @Test fun decode_gitImport_notFit_omitsManifestName() {
        val wire = """{"buildId":"bld-2","fit":false,"reason":"no manifest","fileCount":9}"""
        val r = json.decodeFromString(BuildGitResponse.serializer(), wire)
        assertFalse(r.fit)
        assertNull(r.manifestName)
    }

    @Test fun decode_adapt() {
        val r = json.decodeFromString(BuildAdaptResponse.serializer(), """{"ok":true,"fileCount":12}""")
        assertTrue(r.ok)
        assertEquals(12, r.fileCount)
    }

    @Test fun decode_mcp_connectionWithIdeConfig() {
        val wire = """
            {"buildId":"bld-3","connection":{
              "url":"https://home.harry.flagship.services/mcp/build/bld-3",
              "key":"abcdef",
              "ideConfig":{"mcpServers":{"flagship-build":{"url":"https://x/mcp/build/bld-3","headers":{"Authorization":"Bearer abcdef"}}}}
            }}
        """.trimIndent()
        val r = json.decodeFromString(BuildMcpResponse.serializer(), wire)
        assertEquals("bld-3", r.buildId)
        assertEquals("abcdef", r.connection.key)
        // ideConfig stays an opaque JSON object we can re-serialize for copy.
        assertNotNull(r.connection.ideConfig.jsonObject["mcpServers"])
    }

    @Test fun decode_envRequests_valueFree() {
        val wire = """{"requests":[{"name":"WEATHER_API_KEY","why":"forecast","secret":true,"requestedAt":1700000000000,"requestedBy":"ide","currentlySet":false}]}"""
        val r = json.decodeFromString(BuildEnvRequestsResponse.serializer(), wire)
        val q = r.requests.single()
        assertEquals("WEATHER_API_KEY", q.name)
        assertTrue(q.secret)
        assertFalse(q.currentlySet)
        // No `value` key in the contract — the model has no such field.
    }

    @Test fun decode_sessions() {
        val wire = """{"builds":[{"buildId":"b1","mode":"git","serviceId":"harry--wiki","startedAt":1,"lastAt":2,"entryCount":4,"lastKind":"installed"}]}"""
        val r = json.decodeFromString(BuildSessionsResponse.serializer(), wire)
        val b = r.builds.single()
        assertEquals("git", b.mode)
        assertEquals("harry--wiki", b.serviceId)
        assertEquals(4, b.entryCount)
    }

    @Test fun decode_journal() {
        val wire = """{"entries":[{"seq":1,"ts":1700000000000,"buildId":"b1","mode":"mcp","kind":"write_file","actor":"ide","summary":"wrote src/index.ts"}]}"""
        val r = json.decodeFromString(BuildJournalResponse.serializer(), wire)
        val e = r.entries.single()
        assertEquals(1, e.seq)
        assertEquals("ide", e.actor)
        assertEquals("write_file", e.kind)
        assertNull(e.detail)
    }

    @Test fun decode_deploy() {
        val r = json.decodeFromString(BuildDeployResponse.serializer(), """{"ok":true,"serviceId":"harry-x","url":"https://x.home.harry.flagship.services/"}""")
        assertTrue(r.ok)
        assertEquals("harry-x", r.serviceId)
    }

    @Test fun encode_gitRequest_omitsNullRef() {
        val body = json.encodeToString(BuildGitRequest.serializer(), BuildGitRequest(gitUrl = "https://g/r"))
        assertTrue(body.contains("\"gitUrl\""))
        assertFalse(body.contains("\"ref\"")) // explicitNulls = false drops it
    }

    // ---------- the Mock matches the live wire format ------------------

    @Test fun mock_gitImport_roundTrips() = runTest {
        val mock = MockBuildClient(simulatedLatencyMs = 0).apply { gitFitFixture = true }
        val resp = mock.gitImport(BuildGitRequest("https://g/r"))
        val encoded = json.encodeToString(BuildGitResponse.serializer(), resp)
        val decoded = json.decodeFromString(BuildGitResponse.serializer(), encoded)
        assertEquals(resp, decoded)
        assertTrue(decoded.fit)
    }

    @Test fun mock_mcp_ideConfigIsCursorClineShape() = runTest {
        val mock = MockBuildClient(simulatedLatencyMs = 0)
        val resp = mock.mcpCreate(BuildMcpRequest("android"))
        val cfg = resp.connection.ideConfig.jsonObject
        val servers = cfg["mcpServers"]!!.jsonObject
        val entry = servers["flagship-build"]!!.jsonObject
        assertNotNull(entry["url"])
        assertNotNull(entry["headers"]!!.jsonObject["Authorization"])
        // Encoding the whole connection round-trips through the model.
        val encoded = json.encodeToString(BuildMcpResponse.serializer(), resp)
        val decoded = json.decodeFromString(BuildMcpResponse.serializer(), encoded)
        assertEquals(resp.connection.key, decoded.connection.key)
    }

    @Test fun mock_envRequests_carryNoValue() = runTest {
        val mock = MockBuildClient(simulatedLatencyMs = 0)
        val resp = mock.envRequests("bld-x")
        val encoded = json.encodeToString(BuildEnvRequestsResponse.serializer(), resp)
        assertFalse(encoded.contains("\"value\""))
        assertTrue(encoded.contains("\"name\""))
    }

    @Test fun mock_sessionsAndJournal_roundTrip() = runTest {
        val mock = MockBuildClient(simulatedLatencyMs = 0)
        val sessions = mock.sessions()
        val sEnc = json.encodeToString(BuildSessionsResponse.serializer(), sessions)
        assertEquals(sessions, json.decodeFromString(BuildSessionsResponse.serializer(), sEnc))

        val journal = mock.journal("bld-x")
        val jEnc = json.encodeToString(BuildJournalResponse.serializer(), journal)
        assertEquals(journal, json.decodeFromString(BuildJournalResponse.serializer(), jEnc))
    }
}
