// Pin the demo-mode contract:
//   - the magic username is stable + case-insensitive
//   - activate() leaves AppState in a believable "signed-in" shape
//   - the demo username is reserved on the Mock server side

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockFlagshipServerClient
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DemoFixturesTest {
    @Test fun magicUsernameIsCaseInsensitive() {
        assertTrue(DemoFixtures.isDemoUsername("demo"))
        assertTrue(DemoFixtures.isDemoUsername("DEMO"))
        assertTrue(DemoFixtures.isDemoUsername("Demo"))
        assertTrue(DemoFixtures.isDemoUsername("  demo  "))
        assertFalse(DemoFixtures.isDemoUsername("demouser"))
        assertFalse(DemoFixtures.isDemoUsername(""))
        assertFalse(DemoFixtures.isDemoUsername("harry"))
    }

    @Test fun activate_populatesAppStateWithSamplePods() = runTest {
        val app = AppState()
        DemoFixtures.activate(app)
        assertTrue(app.isPaired.first())
        assertEquals("demo", app.currentUser.first())
        val pods = app.pods.first()
        assertEquals(3, pods.size)
        assertEquals(listOf("Home", "Office", "Music"), pods.map { it.name })
        // First pod becomes leader + current.
        val leader = app.leaderPodId.first()
        assertNotNull(leader)
        assertEquals(leader, app.currentPodId.first())
        // FQDNs are obviously demo-flavored.
        assertTrue(pods.all { it.fqdn.contains(".demo.flagship.services") })
    }

    @Test fun demoUsernameIsReservedOnMockServer() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val r = mock.usernameAvailable("demo")
        assertFalse("demo must be reserved on the server side", r.available)
        assertEquals("Reserved.", r.reason)
    }
}
