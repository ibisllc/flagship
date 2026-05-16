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
        // appId is the immutable composite `<creator>-<slug>`.
        assertEquals(
            listOf("harry-plants", "harry-wiki", "trent-scratchpad").sorted(),
            r.apps.map { it.appId }.sorted(),
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

    @Test fun installEvents_emitsFullSequence() = runTest {
        val events = makeClient().apply { simulatedLatencyMs = 0 }
            .installEvents("TESTSERIAL")
            .toList()
        assertEquals(5, events.size)
        assertTrue(events.first() is InstallEvent.Registered)
        val last = events.last()
        assertTrue(last is InstallEvent.Ready)
        assertEquals("newbox.harry.flagship.services", (last as InstallEvent.Ready).serverFqdn)
    }

    @Test fun vibeCodeStream_emitsBuildAndDeploy() = runTest {
        val frames = makeClient().vibeCodeStream("vc-abc").toList()
        assertTrue(frames.any { it is VibeCodeFrame.BuildStart })
        assertTrue(frames.any { it is VibeCodeFrame.Deploy })
        assertTrue(frames.any { it is VibeCodeFrame.Done })
    }
}
