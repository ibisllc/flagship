package com.flagshipserver.app.core

import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.api.InMemorySessionStore
import com.flagshipserver.app.api.MockFlagshipServerClient
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DemoSessionPairerTest {
    private val username = "demoalice"
    private val server = DemoServerBlock(
        fqdn = "home.demoalice.flagship.services",
        status = "up",
    )

    @Test
    fun ensurePaired_mintsAndPersistsDemoSession() = runTest {
        val client = MockFlagshipServerClient(demoServers = mutableMapOf(username to server))
        val store = InMemorySessionStore()
        val token = "ab".repeat(32)

        val result = DemoSessionPairer.ensurePaired(
            username = username,
            server = server,
            client = client,
            store = store,
            makeToken = { token },
        )

        assertEquals(token, result)
        assertEquals(token, store.sessionToken(forPodId = PodInfo.podId(server.fqdn)))
        assertEquals(token, store.sessionToken.value)
        assertEquals("https://${server.fqdn}", store.podBaseUrl.value)
        assertEquals(username, store.demoSession()?.username)
        assertEquals(server, store.demoSession()?.server)
    }

    @Test
    fun ensurePaired_reusesStoredTokenWithoutCallingBackend() = runTest {
        val client = MockFlagshipServerClient(shouldFail = true)
        val store = InMemorySessionStore()
        store.setSessionToken("existing", forPodId = PodInfo.podId(server.fqdn))

        val result = DemoSessionPairer.ensurePaired(username, server, client, store)

        assertEquals("existing", result)
        assertEquals("existing", store.sessionToken.value)
        assertEquals(username, store.demoSession()?.username)
    }

    @Test
    fun signOutHook_clearsDemoMarker() {
        val store = InMemorySessionStore()
        store.setDemoSession(com.flagshipserver.app.api.DemoSessionRecord(username, server))
        val app = AppState()
        app.onSignedOut = { store.setDemoSession(null) }

        app.signOut()

        assertNull(store.demoSession())
    }
}
