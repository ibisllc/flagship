// Android canonical-channel projection — the fraction, the group labels,
// and the per-step states must match the webapp + iOS renderers
// byte-for-byte. All three derive the SAME projection from the ONE
// canonical phase ladder (ProvisionStatusPhase: booting…live + error) +
// the ONE group table (LOCKED DESIGN §1.2/§1.3). Plus the device-metadata
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

    @Test fun fraction_zeroForNullUnknown_oneForLive_zeroForBareError() {
        assertEquals(0.0, ProvisionProgress.fraction(null), 1e-9)
        assertEquals(0.0, ProvisionProgress.fraction(""), 1e-9)
        assertEquals(0.0, ProvisionProgress.fraction("nope"), 1e-9)
        assertEquals(1.0, ProvisionProgress.fraction("live"), 1e-9)
        assertEquals(0.0, ProvisionProgress.fraction("error"), 1e-9)
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

    @Test fun ladder_isCanonicalNinePhaseVocabulary_installedBetweenInstallingAndRegistering() {
        assertEquals(
            listOf(
                "booting", "downloading", "partitioning", "installing",
                "installed", "registering", "sealing", "pairing", "live",
            ),
            ProvisionProgress.ladder,
        )
    }

    @Test fun stepGroups_canonicalProjection_coverEveryLadderPhaseExactlyOnce() {
        assertEquals(
            listOf("Booting", "Installing", "Install complete — unplug the USB", "Registering", "Securing", "Ready"),
            ProvisionProgress.stepGroups.map { it.label },
        )
        // Every ladder phase appears in exactly one group. NOTE: the §1.2
        // projection groups `pairing` under Registering and `sealing`
        // under Securing, so the flattened group order is NOT the ladder
        // order (sealing precedes pairing in the ladder); assert SET
        // coverage + no duplicates, not positional equality.
        val flat = ProvisionProgress.stepGroups.flatMap { it.phases }
        assertEquals(ProvisionProgress.ladder.toSet(), flat.toSet())
        assertEquals("no phase appears in two groups", flat.size, flat.toSet().size)
        assertEquals("groups cover the whole ladder", ProvisionProgress.ladder.size, flat.size)
    }

    @Test fun stepStates_sealingActivatesSecuringWithCanonicalTitle() {
        val v = ProvisionProgress.stepStates("sealing")
        assertEquals(
            listOf(
                ProvisionProgress.StepState.DONE,      // Booting
                ProvisionProgress.StepState.DONE,      // Installing
                ProvisionProgress.StepState.DONE,      // Installed
                ProvisionProgress.StepState.DONE,      // Registering
                ProvisionProgress.StepState.ACTIVE,    // Securing
                ProvisionProgress.StepState.PENDING,   // Ready
            ),
            v.map { it.state },
        )
        assertEquals(
            "Sealing your disk key",
            v.first { it.key == ProvisionProgress.StepKey.SECURING }.detail,
        )
    }

    @Test fun stepStates_installedIsActionNeeded_notDone() {
        // `installed` activates its own group with the unplug instruction —
        // NOT a done/terminal state (success stays `live`).
        val v = ProvisionProgress.stepStates("installed")
        assertEquals(
            ProvisionProgress.StepState.ACTIVE,
            v.first { it.key == ProvisionProgress.StepKey.INSTALLED }.state,
        )
        assertEquals(
            "Install complete — unplug the USB",
            v.first { it.key == ProvisionProgress.StepKey.INSTALLED }.detail,
        )
    }

    @Test fun stepStates_pairingActivatesRegisteringGroup() {
        // `pairing` is grouped under Registering (1.2 table).
        val v = ProvisionProgress.stepStates("pairing")
        assertEquals(
            ProvisionProgress.StepState.ACTIVE,
            v.first { it.key == ProvisionProgress.StepKey.REGISTERING }.state,
        )
        assertEquals(
            "Pairing with your phone",
            v.first { it.key == ProvisionProgress.StepKey.REGISTERING }.detail,
        )
    }

    @Test fun stepStates_live_allDone() {
        val v = ProvisionProgress.stepStates("live")
        assertTrue(v.all { it.state == ProvisionProgress.StepState.DONE })
    }

    @Test fun stepStates_errorWithHint_marksOwningGroupAndCarriesDetail() {
        val v = ProvisionProgress.stepStates("error", "rate limited by ACME", "sealing")
        assertEquals(ProvisionProgress.StepState.FAILED,
            v.first { it.key == ProvisionProgress.StepKey.SECURING }.state)
        assertEquals("rate limited by ACME",
            v.first { it.key == ProvisionProgress.StepKey.SECURING }.detail)
    }

    @Test fun stepStates_bareError_failsFirstGroup() {
        val v = ProvisionProgress.stepStates("error", "boom")
        assertEquals(ProvisionProgress.StepState.FAILED, v.first().state)
        assertEquals("boom", v.first().detail)
    }

    @Test fun shouldShowProgressBar_listVisibilityLogic() {
        assertFalse(ProvisionProgress.shouldShowProgressBar(null, "none"))
        assertFalse(ProvisionProgress.shouldShowProgressBar("live", "up"))
        assertFalse(ProvisionProgress.shouldShowProgressBar(null, "up"))
        assertTrue(ProvisionProgress.shouldShowProgressBar("installing", "provisioning"))
        assertTrue(ProvisionProgress.shouldShowProgressBar(null, "provisioning"))
        assertTrue(ProvisionProgress.shouldShowProgressBar("error", "provisioning"))
    }

    @Test fun demoServerBlock_decodesDeviceMetadataFromWire() {
        // DemoServerBlock.phase now carries canonical ProvisionStatusPhase
        // values (bucket A re-vocabularied demoUsers.ts).
        val json = """
            {
              "username": "demoalice",
              "available": false,
              "demoServer": {
                "fqdn": "home.demoalice.flagship.services",
                "status": "provisioning",
                "ttlIdleMinutes": 30,
                "phase": "sealing",
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
        assertEquals("sealing", resp.demoServer?.phase)
    }

    @Test fun samplePodFromDemoServer_carriesTheBlockOntoThePod() {
        val block = DemoServerBlock(
            fqdn = "home.demoalice.flagship.services",
            status = "provisioning",
            phase = "installing",
            ip = "1.2.3.4",
            region = "fsn1",
            image = "debian-12",
        )
        val pod = DemoFixtures.samplePodFromDemoServer(block, "demoalice")
        assertEquals(PodInfo.Status.PENDING, pod.status)
        assertEquals("installing", pod.demoServer?.phase)
        assertEquals("1.2.3.4", pod.demoServer?.ip)
    }

    @Test fun cancel_mockRoundTrips_andResetsRowToNone() = runTest {
        val mock = MockFlagshipServerClient()
        mock.demoServers = mutableMapOf(
            "demoalice" to DemoServerBlock(
                fqdn = "home.demoalice.flagship.services", status = "provisioning", phase = "installing"
            )
        )
        val demo = MockDemoConnectClient(mock)
        demo.cancel("demoalice")
        assertEquals(listOf("demoalice"), demo.cancelCalls)
        assertEquals("none", mock.demoServers["demoalice"]?.status)
    }
}
