// Mirror of FlagshipMobileTests/MockScreensClientTests.swift. Runs on
// the JVM (no Robolectric) since Mock/Screen/AppState are all pure
// Kotlin — keeps the test suite fast.

package com.flagshipserver.app.api

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MockScreensClientTest {

    private fun makeClient() = MockScreensClient(simulatedLatencyMs = 0)

    @Test fun serverDetail_variesByPodContext() = runTest {
        val c = makeClient()
        c.podContext = "home"
        val home = c.serverDetail()
        c.podContext = "office"
        val office = c.serverDetail()
        assertEquals("home.harry.flagship.services", home.serverFqdn)
        assertEquals("office.harry.flagship.services", office.serverFqdn)
    }

    @Test fun appsList_returnsKnownApps() = runTest {
        val r = makeClient().appsList()
        // serviceId is the immutable composite `<creator>-<slug>`.
        assertEquals(
            listOf("harry-plants", "harry-wiki", "trent-scratchpad").sorted(),
            r.apps.map { it.serviceId }.sorted(),
        )
    }

    @Test fun appDetail_throwsOnUnknownApp() = runTest {
        try {
            makeClient().appDetail("nope")
            fail("expected throw")
        } catch (e: ScreensError.Http) {
            assertEquals(404, e.status)
        }
    }

    @Test fun appDetail_matchesLiveWireShape() = runTest {
        // The Mock must return the SAME AppDetailResponse shape the live
        // daemon serves (screensHttp app-detail → BFF types.ts), so the
        // ServiceDetailViewModel renders identically against either client.
        val r = makeClient().appDetail("harry-plants")
        // app summary — the tier-1 url is the live `https://<urlLabel>.<fqdn>` form.
        assertEquals("harry-plants", r.app.serviceId)
        assertEquals("harry", r.app.creator)
        assertEquals("plants", r.app.slug)
        assertTrue(r.app.url.startsWith("https://plants."))
        assertTrue(r.app.url.endsWith("/"))
        assertEquals("running", r.app.status)
        // detail body — every field the BFF promises is present.
        assertTrue(r.manifest.isNotEmpty())
        assertTrue(r.dataLayerInstances.isNotEmpty())
        assertEquals("postgres", r.dataLayerInstances.first().store)
        assertTrue(r.members.isNotEmpty())
        assertEquals("owner", r.members.first().role)
        // browserTabs present (empty is a valid steady state), lastBackup +
        // recentLogs populated.
        assertNotNull(r.browserTabs)
        assertNotNull(r.lastBackup)
        assertTrue(r.lastBackup!!.bytes > 0)
        assertTrue(r.recentLogs.isNotEmpty())
    }

    @Test fun serverMetrics_returnsSixtySamples() = runTest {
        val m = makeClient().serverMetrics("home")
        assertEquals(60, m.cpuHistory.size)
        assertEquals(60, m.memHistory.size)
        assertEquals(60, m.ioHistory.size)
        assertEquals(60, m.netHistory.size)
        assertTrue(m.memTotalBytes > m.memUsedBytes)
        assertTrue(m.diskTotalBytes > m.diskUsedBytes)
        assertTrue(m.cpuPercent in 0.0..100.0)
    }

    @Test fun serverMetrics_yieldsDistinctSeriesAcrossPods() = runTest {
        val c = makeClient()
        val home = c.serverMetrics("home")
        val office = c.serverMetrics("office")
        assertNotEquals(home.cpuHistory.map { it.value }, office.cpuHistory.map { it.value })
    }

    @Test fun verifyCustomDomain_pendingThenVerified() = runTest {
        val c = makeClient()
        val first = c.verifyCustomDomain(VerifyCustomDomainRequest("app.mydomain.com"))
        assertEquals(VerifyCustomDomainResponse.Status.PENDING, first.status)
        assertNotNull(first.reason)

        val second = c.verifyCustomDomain(VerifyCustomDomainRequest("app.mydomain.com"))
        assertEquals(VerifyCustomDomainResponse.Status.VERIFIED, second.status)
        assertEquals(second.expectedTxtRecord, second.observedTxtRecord)
        assertNull(second.reason)
    }

    @Test fun fetchProvisionStatus_returnsScriptedRecord_orNullWhenAbsent() = runTest {
        // The ONE canonical provisioning channel lives on
        // FlagshipServerClient (flagshipserver.com), NOT the pod-gated
        // ScreensClient — the box is still installing, so no pod exists.
        // Absent serial mirrors the Worker's 404 "no record yet" → null.
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        assertNull(server.fetchProvisionStatus("ORDER-1"))

        server.provisionStatuses["ORDER-1"] = ProvisionStatusRecord(
            serial = "ORDER-1",
            serverDomain = "newbox.harry.flagship.services",
            phase = "live",
            updatedAt = 1_700_000_000_000L,
            history = listOf(
                ProvisionStatusEntry(phase = "booting", ts = 1L),
                ProvisionStatusEntry(phase = "live", ts = 2L),
            ),
        )
        val rec = server.fetchProvisionStatus("ORDER-1")
        assertEquals("live", rec?.phase)
        assertEquals("newbox.harry.flagship.services", rec?.serverDomain)
        assertEquals(ProvisionStatusPhase.LIVE, ProvisionStatusPhase.fromWire(rec?.phase))
        assertTrue(ProvisionStatusPhase.fromWire(rec?.phase).isTerminal)
    }

    @Test fun vibeCodeStream_emitsBuildAndDeploy() = runTest {
        val frames = makeClient().vibeCodeStream("vc-abc").toList()
        assertTrue(frames.any { it is VibeCodeFrame.BuildStart })
        assertTrue(frames.any { it is VibeCodeFrame.Deploy })
        assertTrue(frames.any { it is VibeCodeFrame.Done })
    }

    // ── W10 — per-app env-var KV editor + vibe-code session ─────────

    @Test fun serviceEnvList_returnsSortedNamesOnly() = runTest {
        val c = makeClient()
        val r = c.serviceEnvList("harry-plants")
        assertTrue(r.names.contains("WEATHER_API_KEY"))
    }

    @Test fun serviceEnvSet_thenList_includesNewName() = runTest {
        val c = makeClient()
        val envelope = ServiceEnvSetEnvelope(
            serverId = "home.harry.flagship.services",
            creator = "harry", slug = "plants",
            env = mapOf("FOO" to "bar-NEVER-LEAKED"),
            issuedAt = 1L,
        )
        c.serviceEnvSet(
            "harry-plants",
            ServiceEnvSetRequest(name = "FOO", value = "bar-NEVER-LEAKED", request = envelope, signature = "00"),
        )
        val r = c.serviceEnvList("harry-plants")
        assertTrue(r.names.contains("FOO"))
    }

    @Test fun serviceEnvUnset_dropsName() = runTest {
        val c = makeClient()
        val envelope = ServiceEnvSetEnvelope(
            serverId = "home.harry.flagship.services",
            creator = "harry", slug = "plants",
            env = emptyMap(),
            issuedAt = 1L,
        )
        c.serviceEnvUnset(
            "harry-plants",
            ServiceEnvUnsetRequest(name = "WEATHER_API_KEY", request = envelope, signature = "00"),
        )
        val r = c.serviceEnvList("harry-plants")
        assertTrue(!r.names.contains("WEATHER_API_KEY"))
    }

    @Test fun vibeCodeSessionState_surfacesPendingRequestEnvVar() = runTest {
        val c = makeClient()
        val r = c.vibeCodeSessionState("sess-42")
        assertEquals("awaiting-tool-response", r.status)
        val pending = r.pendingRequest
        assertNotNull(pending)
        val ev = pending as VibeCodePendingRequest.RequestEnvVar
        assertEquals("WEATHER_API_KEY", ev.payload.name)
        assertEquals(true, ev.payload.secret)
    }

    @Test fun vibeCodePendingRequest_serializationHasNoValueField() {
        // STRUCTURAL invariant — the pendingRequest wire shape must not
        // carry a `value` key. Mirrors the screensHttpW10.test.ts assertion.
        val pending: VibeCodePendingRequest = VibeCodePendingRequest.RequestEnvVar(
            toolUseId = "tu_1",
            payload = RequestEnvVarPayload(
                name = "OPENAI_API_KEY",
                description = "your key",
                why = "for completions",
                example = "sk-…",
                secret = true,
            ),
        )
        val json = kotlinx.serialization.json.Json {
            classDiscriminator = "kind"
            encodeDefaults = true
        }
        val s = json.encodeToString(VibeCodePendingRequest.serializer(), pending)
        assertTrue(s.contains("requestEnvVar"))
        assertTrue(!s.contains("\"value\""))
    }
}
