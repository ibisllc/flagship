// Plan A — pin the `/api/users/check` extension contract on Android.
//
// Mirror of the iOS DemoServerBlockTests + the Worker behaviour
// (docs/sample-users.md §10.9):
//   - When a typed username matches a `demo_users` row, the response
//     carries a `demoServer` block (fqdn + status + ttlIdleMinutes).
//   - When the username carries ONLY a `testAccount` block (legacy),
//     the `demoServer` field is null and DemoFixtures falls back to
//     the 3-fixture path so already-shipped binaries still work.
//   - The connect mock POSTs `/connect` (which flips the row to
//     `provisioning` / `up`); pollUntilUp returns the up-block.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.DemoConnectException
import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.api.MockDemoConnectClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.TestAccountMeta
import com.flagshipserver.app.api.UsernameAvailabilityResponse
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DemoServerBlockTest {

    // ─── Mock-level (Worker mirror) ────────────────────────────────

    @Test fun mockUsersCheck_omitsDemoServer_whenUsernameNotConfigured() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val r = mock.usernameAvailable("harry")
        assertNull(r.demoServer)
    }

    @Test fun mockUsersCheck_includesDemoServer_whenConfigured() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            testAccounts = mapOf("demo-alice" to TestAccountMeta("Demo Alice", 24))
            demoServers = mutableMapOf(
                "demo-alice" to DemoServerBlock(
                    fqdn = "home.demo-alice.flagship.services",
                    status = "none",
                    ttlIdleMinutes = 30,
                )
            )
        }
        val r = mock.usernameAvailable("demo-alice")
        assertEquals(false, r.available)
        assertNotNull(r.testAccount)
        assertEquals("home.demo-alice.flagship.services", r.demoServer?.fqdn)
        assertEquals("none", r.demoServer?.status)
        assertEquals(DemoServerBlock.Lifecycle.None, r.demoServer?.lifecycle)
        assertEquals(30, r.demoServer?.ttlIdleMinutes)
    }

    @Test fun demoServerBlock_decodesFromWorkerWireShape() {
        // Wire shape mirrors packages/control-plane/src/demoUsers.ts
        // `demoServerBlockFromRow` — keep these byte-identical.
        val json = """
        {
          "username": "demo-alice",
          "available": false,
          "reason": "test account",
          "testAccount": {"display":"Demo Alice","ttlHours":24},
          "demoServer": {
            "fqdn": "home.demo-alice.flagship.services",
            "status": "provisioning",
            "ttlIdleMinutes": 30
          }
        }
        """.trimIndent()
        val resp = Json { ignoreUnknownKeys = true; explicitNulls = false }
            .decodeFromString(UsernameAvailabilityResponse.serializer(), json)
        assertEquals("home.demo-alice.flagship.services", resp.demoServer?.fqdn)
        assertEquals(DemoServerBlock.Lifecycle.Provisioning, resp.demoServer?.lifecycle)
    }

    @Test fun demoServerLifecycle_unknownStatusFallsBackToProvisioning() {
        // Forward-compat: an old binary reading a new Worker status
        // shouldn't open an unhealthy pod — collapse to provisioning
        // so the client polls instead.
        val block = DemoServerBlock("x.flagship.services", "weird-future-state", 30)
        assertEquals(DemoServerBlock.Lifecycle.Provisioning, block.lifecycle)
    }

    // ─── DemoFixtures fork ──────────────────────────────────────────

    @Test fun activate_demoServerPresent_rendersOneRealDevice() = runTest {
        val app = AppState()
        val block = DemoServerBlock(
            fqdn = "home.demo-alice.flagship.services",
            status = "none",
            ttlIdleMinutes = 30,
        )
        DemoFixtures.activate(app, "demo-alice", demoServer = block)
        val pods = app.pods.first()
        assertEquals("demoServer-present path must render ONE device", 1, pods.size)
        assertEquals("home.demo-alice.flagship.services", pods.first().fqdn)
        assertEquals("status='none' maps to PENDING until /connect",
            PodInfo.Status.PENDING, pods.first().status)
        assertTrue(app.isPaired.first())
        assertEquals("demo-alice", app.currentUser.first())
    }

    @Test fun activate_demoServerNil_fallsBackToThreeFixtures() = runTest {
        // Backward compat: an already-shipped Worker that only has a
        // TEST_ACCOUNTS entry (no demo_users row) keeps producing
        // the legacy 3-pod sandbox.
        val app = AppState()
        DemoFixtures.activate(app, "play-reviewer-q2", demoServer = null)
        val pods = app.pods.first()
        assertEquals("demoServer-absent path keeps the legacy 3 fixtures",
            3, pods.size)
        assertEquals(listOf("Home", "Office", "Music"), pods.map { it.name })
    }

    @Test fun activate_defaultOverloadStillFallsBackToFixtures() = runTest {
        // The legacy 2-arg activate(_:username:) callers (older code
        // paths) must still get the 3-pod sandbox — i.e. the new
        // demoServer param is a non-breaking optional default.
        val app = AppState()
        DemoFixtures.activate(app, "play-reviewer-q2")
        assertEquals(3, app.pods.first().size)
    }

    @Test fun samplePodFromDemoServer_upStatusMapsToOnline() {
        val block = DemoServerBlock("home.demo-alice.flagship.services", "up", 30)
        val pod = DemoFixtures.samplePodFromDemoServer(block, "demo-alice")
        assertEquals(PodInfo.Status.ONLINE, pod.status)
        assertEquals("home.demo-alice.flagship.services", pod.fqdn)
    }

    @Test fun samplePodFromDemoServer_provisioningMapsToPending() {
        val block = DemoServerBlock("home.demo-alice.flagship.services", "provisioning", 30)
        val pod = DemoFixtures.samplePodFromDemoServer(block, "demo-alice")
        assertEquals(PodInfo.Status.PENDING, pod.status)
    }

    // ─── DemoConnectClient (Mock) ───────────────────────────────────

    @Test fun mockDemoConnect_flipsStatusFromNoneToUp_synchronously() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            demoServers = mutableMapOf(
                "demo-alice" to DemoServerBlock(
                    fqdn = "home.demo-alice.flagship.services",
                    status = "none",
                    ttlIdleMinutes = 30,
                )
            )
        }
        val connect = MockDemoConnectClient(server = mock)  // sync flip default
        connect.connect("demo-alice")
        assertEquals(listOf("demo-alice"), connect.connectCalls)
        val r = mock.usernameAvailable("demo-alice")
        assertEquals(DemoServerBlock.Lifecycle.Up, r.demoServer?.lifecycle)
    }

    @Test fun mockDemoConnect_pollUntilUp_returnsUpBlock() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            demoServers = mutableMapOf(
                "demo-alice" to DemoServerBlock(
                    fqdn = "home.demo-alice.flagship.services",
                    status = "up",
                    ttlIdleMinutes = 30,
                )
            )
        }
        val connect = MockDemoConnectClient(server = mock)
        val block = connect.pollUntilUp("demo-alice", pollIntervalMs = 10, timeoutMs = 1000)
        assertEquals(DemoServerBlock.Lifecycle.Up, block.lifecycle)
    }

    @Test fun mockDemoConnect_pollUntilUp_timesOutWhenStuckProvisioning() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            demoServers = mutableMapOf(
                "demo-alice" to DemoServerBlock(
                    fqdn = "home.demo-alice.flagship.services",
                    status = "provisioning",
                    ttlIdleMinutes = 30,
                )
            )
        }
        val connect = MockDemoConnectClient(server = mock)
        try {
            connect.pollUntilUp("demo-alice", pollIntervalMs = 10, timeoutMs = 50)
            fail("expected TimedOut")
        } catch (e: DemoConnectException.TimedOut) {
            assertEquals("provisioning", e.lastStatus)
        }
    }

    @Test fun mockDemoConnect_pollUntilUp_failsWhenDemoServerWentAway() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val connect = MockDemoConnectClient(server = mock)
        try {
            connect.pollUntilUp("demo-alice", pollIntervalMs = 10, timeoutMs = 50)
            fail("expected DemoServerWentAway")
        } catch (_: DemoConnectException.DemoServerWentAway) {
            // expected
        }
    }
}
