// Android mirror of packages/protocol/src/provisionProgress.ts — the
// fraction, the four-group labels, and the per-step states must match
// the webapp + iOS renderers byte-for-byte. Plus the device-metadata
// wire decode + the cancel client round-trip.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.api.MockDemoConnectClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.UsernameAvailabilityResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProvisionProgressTest {

    @Test fun fraction_zeroForNullUnknown_oneForReady_zeroForBareFailed() {
        assertEquals(0.0, ProvisionProgress.fraction(null), 1e-9)
        assertEquals(0.0, ProvisionProgress.fraction(""), 1e-9)
        assertEquals(0.0, ProvisionProgress.fraction("nope"), 1e-9)
        assertEquals(1.0, ProvisionProgress.fraction("ready"), 1e-9)
        assertEquals(0.0, ProvisionProgress.fraction("failed"), 1e-9)
    }

    @Test fun fraction_monotonicAlongLadder() {
        var prev = -1.0
        for (phase in ProvisionProgress.ladder) {
            val f = ProvisionProgress.fraction(phase)
            assertTrue("phase $phase not increasing", f > prev)
            assertTrue(f > 0.0)
            assertTrue(f <= 1.0)
            prev = f
        }
    }

    @Test fun stepGroups_fourGroupsWithCanonicalLabels_coverLadderOnce() {
        assertEquals(
            listOf("Booting", "Registering", "Securing (TLS certificate)", "Ready"),
            ProvisionProgress.stepGroups.map { it.label },
        )
        assertEquals(ProvisionProgress.ladder, ProvisionProgress.stepGroups.flatMap { it.phases })
    }

    @Test fun stepStates_acmeSubphaseActivatesSecuringWithTitle() {
        val v = ProvisionProgress.stepStates("dns01-propagation-wait")
        assertEquals(
            listOf(
                ProvisionProgress.StepState.DONE,
                ProvisionProgress.StepState.DONE,
                ProvisionProgress.StepState.ACTIVE,
                ProvisionProgress.StepState.PENDING,
            ),
            v.map { it.state },
        )
        assertEquals("Waiting for DNS", v.first { it.key == ProvisionProgress.StepKey.SECURING }.detail)
    }

    @Test fun stepStates_ready_allDone() {
        val v = ProvisionProgress.stepStates("ready")
        assertTrue(v.all { it.state == ProvisionProgress.StepState.DONE })
    }

    @Test fun stepStates_failedWithHint_marksOwningGroupAndCarriesError() {
        val v = ProvisionProgress.stepStates("failed", "rate limited by ACME", "acme-validating")
        assertEquals(ProvisionProgress.StepState.FAILED,
            v.first { it.key == ProvisionProgress.StepKey.SECURING }.state)
        assertEquals("rate limited by ACME",
            v.first { it.key == ProvisionProgress.StepKey.SECURING }.detail)
    }

    @Test fun stepStates_bareFailed_failsFirstGroup() {
        val v = ProvisionProgress.stepStates("failed", "boom")
        assertEquals(ProvisionProgress.StepState.FAILED, v.first().state)
        assertEquals("boom", v.first().detail)
    }

    @Test fun shouldShowProgressBar_listVisibilityLogic() {
        assertFalse(ProvisionProgress.shouldShowProgressBar(null, "none"))
        assertFalse(ProvisionProgress.shouldShowProgressBar("ready", "up"))
        assertFalse(ProvisionProgress.shouldShowProgressBar(null, "up"))
        assertTrue(ProvisionProgress.shouldShowProgressBar("deps", "provisioning"))
        assertTrue(ProvisionProgress.shouldShowProgressBar(null, "provisioning"))
        assertTrue(ProvisionProgress.shouldShowProgressBar("failed", "provisioning"))
    }

    @Test fun demoServerBlock_decodesDeviceMetadataFromWire() {
        val json = """
            {
              "username": "demoalice",
              "available": false,
              "demoServer": {
                "fqdn": "home.demoalice.flagship.services",
                "status": "provisioning",
                "ttlIdleMinutes": 30,
                "phase": "acme-validating",
                "phaseAt": 12345,
                "ip": "1.2.3.4",
                "region": "fsn1",
                "serverType": "cx22",
                "image": "debian-12"
              }
            }
        """.trimIndent()
        val resp = Json { ignoreUnknownKeys = true; explicitNulls = false }
            .decodeFromString(UsernameAvailabilityResponse.serializer(), json)
        assertEquals("1.2.3.4", resp.demoServer?.ip)
        assertEquals("fsn1", resp.demoServer?.region)
        assertEquals("cx22", resp.demoServer?.serverType)
        assertEquals("debian-12", resp.demoServer?.image)
        assertEquals("acme-validating", resp.demoServer?.phase)
    }

    @Test fun samplePodFromDemoServer_carriesTheBlockOntoThePod() {
        val block = DemoServerBlock(
            fqdn = "home.demoalice.flagship.services",
            status = "provisioning",
            phase = "deps",
            ip = "1.2.3.4",
            region = "fsn1",
            image = "debian-12",
        )
        val pod = DemoFixtures.samplePodFromDemoServer(block, "demoalice")
        assertEquals(PodInfo.Status.PENDING, pod.status)
        assertEquals("deps", pod.demoServer?.phase)
        assertEquals("1.2.3.4", pod.demoServer?.ip)
    }

    @Test fun cancel_mockRoundTrips_andResetsRowToNone() = runTest {
        val mock = MockFlagshipServerClient()
        mock.demoServers = mutableMapOf(
            "demoalice" to DemoServerBlock(
                fqdn = "home.demoalice.flagship.services", status = "provisioning", phase = "deps"
            )
        )
        val demo = MockDemoConnectClient(mock)
        demo.cancel("demoalice")
        assertEquals(listOf("demoalice"), demo.cancelCalls)
        assertEquals("none", mock.demoServers["demoalice"]?.status)
    }
}
