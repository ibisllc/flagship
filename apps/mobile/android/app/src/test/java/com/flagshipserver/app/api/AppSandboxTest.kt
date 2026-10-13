// The sandbox apps run in (server-detail `appSandbox`, docs/app-runtimes.md
// §5.1): an older daemon omits it, and the server page's copy matches web.

package com.flagshipserver.app.api

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppSandboxTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val base = """"serverFqdn":"home.harry.flagship.services","username":"harry","daemonVersion":"0.1.0","startedAt":1,"uptimeMs":2,"serviceCount":0,"pairedSessionCount":0,"recentInstallEvents":[]"""

    private fun detail(extra: String) = json.decodeFromString(ServerDetailResponse.serializer(), "{$base$extra}")

    @Test
    fun olderDaemonWithoutTheFieldSaysNothing() {
        assertNull(detail("").appSandbox)
    }

    @Test
    fun unavailableWarnsWithTheReason() {
        val n = detail(""","appSandbox":{"state":"unavailable","reason":"no network"}""").appSandbox!!.notice!!
        assertTrue(n.danger)
        assertEquals(
            "Apps can't start on this server: the sandbox they run in isn't working (no network). The server tries again every 10 minutes.",
            n.text,
        )
    }

    @Test
    fun readyAndOffSayNothing_startingSaysItsBeingSetUp() {
        assertNull(detail(""","appSandbox":{"state":"ready","version":"runsc"}""").appSandbox!!.notice)
        assertNull(detail(""","appSandbox":{"state":"off"}""").appSandbox!!.notice)
        assertEquals(false, detail(""","appSandbox":{"state":"starting"}""").appSandbox!!.notice!!.danger)
    }
}
