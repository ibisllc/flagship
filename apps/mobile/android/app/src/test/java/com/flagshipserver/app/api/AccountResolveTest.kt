// Pin the login/join preflight contract on Android.
//
// Mirror of the Worker behaviour (packages/control-plane/src/
// accountResolve.ts) + the iOS AccountResolution mirror:
//   - resolveAccount returns 200-shaped data ALWAYS — a missing
//     account is kind="unknown" with zeroed factors, NEVER an error.
//   - a seeded demo username resolves to kind="demo" + a demoServer
//     block; demo crypto is a no-op so the join skips every credential.
//   - the demo branch, fed into DemoFixtures.activate, opens the
//     account (a freshly-attached device + the sandbox pod).
//   - the wire decodes byte-identically from the Worker JSON shape.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.DemoFixtures
import com.flagshipserver.app.core.PodInfo
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountResolveTest {

    // ─── Mock wire: demo ────────────────────────────────────────────

    @Test fun resolveAccount_seededDemoUsername_resolvesToDemo() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            demoServers = mutableMapOf(
                "demoalice" to DemoServerBlock(
                    fqdn = "home.demoalice.flagship.services",
                    status = "up",
                    ttlIdleMinutes = 30,
                ),
            )
        }
        val r = mock.resolveAccount("demoalice")
        assertTrue(r.exists)
        assertEquals("demo", r.kind)
        assertEquals(AccountResolution.AccountKind.Demo, r.accountKind)
        // Demo crypto is a no-op — no recovery / TOTP factors.
        assertFalse(r.recovery.present)
        assertFalse(r.totpEnrolled)
        assertEquals("instant", r.graceModel)
        assertEquals(AccountResolution.GraceModel.Instant, r.grace)
        // The demoServer block rides along so the join can activate the
        // sandbox without a second round-trip.
        assertNotNull(r.demoServer)
        assertEquals("home.demoalice.flagship.services", r.demoServer?.fqdn)
    }

    @Test fun resolveAccount_demoMatch_isCaseInsensitive() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            demoServers = mutableMapOf(
                "demoalice" to DemoServerBlock("home.demoalice.flagship.services", "none", 30),
            )
        }
        val r = mock.resolveAccount("DemoAlice")
        assertEquals("demo", r.kind)
        assertEquals("demoalice", r.username)
    }

    // ─── Mock wire: unknown (never a 404) ───────────────────────────

    @Test fun resolveAccount_unknownUsername_resolvesToUnknownWithZeroedFactors() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val r = mock.resolveAccount("nobody")
        assertFalse(r.exists)
        assertEquals("unknown", r.kind)
        assertEquals(AccountResolution.AccountKind.Unknown, r.accountKind)
        assertFalse(r.recovery.present)
        assertFalse(r.recovery.hasFetchGate)
        assertNull(r.recovery.credentialId)
        assertFalse(r.totpEnrolled)
        assertNull(r.demoServer)
        assertEquals("none", r.graceModel)
        assertEquals(AccountResolution.GraceModel.None, r.grace)
    }

    // ─── Mock wire: claimed real account ────────────────────────────

    @Test fun resolveAccount_claimedSingleAccount_resolvesToSingle() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        mock.claimUsername(
            UsernameClaimRequest(
                request = UsernameClaimRequest.Inner(
                    username = "harry",
                    irkPub = "ab".repeat(32),
                    issuedAt = 0L,
                ),
                signature = "00",
            ),
        )
        val r = mock.resolveAccount("harry")
        assertTrue(r.exists)
        assertEquals("single", r.kind)
        assertEquals("3d", r.graceModel)
    }

    @Test fun resolveAccount_claimedMultiAccount_resolvesToMulti() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        mock.claimUsername(
            UsernameClaimRequest(
                request = UsernameClaimRequest.Inner("hilton", "cd".repeat(32), 0L),
                signature = "00",
            ),
        )
        mock.accountTypeByUser["hilton"] = "multi"
        mock.totpEnrolledAtByUser["hilton"] = 123L
        val r = mock.resolveAccount("hilton")
        assertEquals("multi", r.kind)
        assertTrue(r.totpEnrolled)
        assertEquals("24h-totp", r.graceModel)
    }

    // ─── demo-join opens the account ────────────────────────────────

    @Test fun demoBranch_activatesAccount() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            demoServers = mutableMapOf(
                "demoalice" to DemoServerBlock("home.demoalice.flagship.services", "up", 30),
            )
        }
        val app = AppState()
        // Drive the JoinAccountContainer's demo branch logic directly:
        // resolve → kind==demo → DemoFixtures.activate(demoServer).
        val r = mock.resolveAccount("demoalice")
        assertEquals(AccountResolution.AccountKind.Demo, r.accountKind)
        DemoFixtures.activate(app, r.username, demoServer = r.demoServer)

        assertTrue("demo join must open the account", app.isPaired.first())
        assertEquals("demoalice", app.currentUser.first())
        val pods = app.pods.first()
        assertEquals("demoServer-present path renders ONE device", 1, pods.size)
        assertEquals("home.demoalice.flagship.services", pods.first().fqdn)
        assertEquals(PodInfo.Status.ONLINE, pods.first().status)
    }

    // ─── unknown state does NOT open the account ────────────────────

    @Test fun unknownBranch_doesNotOpenAccount() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val r = mock.resolveAccount("nobody")
        // The container renders the "no account" STATE and never calls
        // activate — assert the precondition the UI branches on.
        assertEquals(AccountResolution.AccountKind.Unknown, r.accountKind)
        assertNull(r.demoServer)
        assertFalse(app.isPaired.first())
        assertNull(app.currentUser.first())
    }

    // ─── wire decode (byte-identical to the Worker) ─────────────────

    @Test fun accountResolution_decodesFromWorkerWireShape() {
        // Mirrors packages/control-plane/src/accountResolve.ts — keep
        // these byte-identical (iOS-Mock-matches-Worker invariant).
        val json = """
        {
          "username": "demoalice",
          "exists": true,
          "kind": "demo",
          "recovery": { "present": false, "hasFetchGate": false },
          "totpEnrolled": false,
          "demoServer": {
            "fqdn": "home.demoalice.flagship.services",
            "status": "provisioning",
            "ttlIdleMinutes": 30
          },
          "graceModel": "instant"
        }
        """.trimIndent()
        val r = Json { ignoreUnknownKeys = true; explicitNulls = false }
            .decodeFromString(AccountResolution.serializer(), json)
        assertEquals("demoalice", r.username)
        assertEquals(AccountResolution.AccountKind.Demo, r.accountKind)
        assertEquals(DemoServerBlock.Lifecycle.Provisioning, r.demoServer?.lifecycle)
        assertEquals(AccountResolution.GraceModel.Instant, r.grace)
    }

    @Test fun accountResolution_unknownWireShape_decodesToZeroedUnknown() {
        val json = """
        {
          "username": "nobody",
          "exists": false,
          "kind": "unknown",
          "recovery": { "present": false, "hasFetchGate": false },
          "totpEnrolled": false,
          "graceModel": "none"
        }
        """.trimIndent()
        val r = Json { ignoreUnknownKeys = true; explicitNulls = false }
            .decodeFromString(AccountResolution.serializer(), json)
        assertFalse(r.exists)
        assertEquals(AccountResolution.AccountKind.Unknown, r.accountKind)
        assertNull(r.demoServer)
        assertEquals(AccountResolution.GraceModel.None, r.grace)
    }

    @Test fun accountKind_unknownFutureString_parsesAsUnknown() {
        val r = AccountResolution(
            username = "x",
            exists = true,
            kind = "enterprise-sso",  // a value this binary doesn't know
            recovery = AccountResolution.RecoveryState(false, false),
            totpEnrolled = false,
            graceModel = "quantum",
        )
        assertEquals(AccountResolution.AccountKind.Unknown, r.accountKind)
        assertEquals(AccountResolution.GraceModel.None, r.grace)
    }
}
