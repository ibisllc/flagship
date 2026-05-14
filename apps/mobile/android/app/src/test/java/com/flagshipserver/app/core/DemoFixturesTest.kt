// Pin the test-account / demo-mode contract:
//   - activate() leaves AppState in a believable "signed-in" shape
//     for whatever username the Worker confirmed as a test account
//   - the Mock server, when configured with a test-account map,
//     returns the right testAccount block on usernameAvailable
//   - the Mock server, default-configured, exposes NO test accounts
//     (the open-source code is empty by design)

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.TestAccountMeta
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DemoFixturesTest {
    @Test fun activate_populatesAppStateWithSamplePods() = runTest {
        val app = AppState()
        DemoFixtures.activate(app, "play-reviewer-q2")
        assertTrue(app.isPaired.first())
        assertEquals("play-reviewer-q2", app.currentUser.first())
        val pods = app.pods.first()
        assertEquals(3, pods.size)
        assertEquals(listOf("Home", "Office", "Music"), pods.map { it.name })
        val leader = app.leaderPodId.first()
        assertNotNull(leader)
        assertEquals(leader, app.currentPodId.first())
        // FQDNs are scoped to the demo username so they're obviously
        // sample data — not collision-able with a real pod.
        assertTrue(pods.all { it.fqdn.contains(".play-reviewer-q2.flagship.services") })
    }

    @Test fun defaultMockServer_hasNoTestAccountsConfigured() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        // The OSS default ships with an empty testAccounts map; only
        // explicitly-configured tests + the Worker secret enable any
        // accounts.
        val r = mock.usernameAvailable("playreview")
        assertNull(r.testAccount)
    }

    @Test fun mockServer_surfacesConfiguredTestAccount() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            testAccounts = mapOf("playreview-q2" to TestAccountMeta(display = "Play Reviewer (Q2)", ttlHours = 6))
        }
        val r = mock.usernameAvailable("playreview-q2")
        assertEquals(false, r.available)
        assertEquals("test account", r.reason)
        assertEquals(TestAccountMeta("Play Reviewer (Q2)", 6), r.testAccount)
    }

    @Test fun testAccountMatch_isCaseInsensitive() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            testAccounts = mapOf("playreview-q2" to TestAccountMeta("Play Reviewer", 6))
        }
        val r = mock.usernameAvailable("PlayReview-Q2")
        assertEquals("Play Reviewer", r.testAccount?.display)
    }

    @Test fun nonConfiguredName_doesNotLeakTestAccountList() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            testAccounts = mapOf(
                "playreview-q2" to TestAccountMeta("PR", 6),
                "internal-tester" to TestAccountMeta("IT", 24),
            )
        }
        val r = mock.usernameAvailable("harry")
        // A non-matching name returns the normal availability shape
        // with no test-account info.
        assertEquals(true, r.available)
        assertNull(r.testAccount)
    }
}
