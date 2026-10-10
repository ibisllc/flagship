// The box's verdict on the last update order (server-detail `lastUpdate`):
// an older daemon omits it, and the card copy matches web and iOS.

package com.flagshipserver.app.api

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LastUpdateTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val a = "a".repeat(40)
    private val b = "b".repeat(40)
    private val base = """"serverFqdn":"home.harry.flagship.services","username":"harry","daemonVersion":"0.1.0","startedAt":1,"uptimeMs":2,"serviceCount":0,"pairedSessionCount":0,"recentInstallEvents":[]"""

    @Test
    fun olderDaemonWithoutTheFieldStillDecodes() {
        val d = json.decodeFromString(ServerDetailResponse.serializer(), "{$base}")
        assertNull(d.lastUpdate)
    }

    @Test
    fun rollbackNamesBothCommits() {
        val d = json.decodeFromString(
            ServerDetailResponse.serializer(),
            """{$base,"lastUpdate":{"outcome":"rolled-back","at":5,"previousCommit":"$a","targetCommit":"$b","bootAttempts":3}}""",
        )
        assertEquals(
            "The last update to bbbbbbbb didn't start cleanly, so the server went back to aaaaaaaa on its own.",
            d.lastUpdate?.summary,
        )
    }

    @Test
    fun refusalsExplainKnownReasonsOnly() {
        assertEquals(
            "The server refused the last update: Flagship's maintainers haven't endorsed that release.",
            LastUpdate(outcome = "refused", at = 1, reason = "unendorsed").summary,
        )
        assertEquals("The server refused the last update.", LastUpdate(outcome = "refused", at = 1, reason = "new").summary)
        assertNull(LastUpdate(outcome = "exploded", at = 1).summary)
    }
}
