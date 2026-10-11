package com.flagshipserver.app.core

import com.flagshipserver.app.api.BoxHealthDaemonWire
import com.flagshipserver.app.api.BoxHealthWire
import com.flagshipserver.app.api.PodsDirectoryResponse
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerHealthVerdictTest {
    private val now = 1_800_000_000_000L

    private fun healthy(
        uptimeS: Long = 3 * 86_400 + 4 * 3_600 + 120,
        oomKills: Long = 0,
        state: String = "active",
        restarts: Long = 0,
        lastExit: Long = 0,
        tunnel: Boolean = true,
        diskUsedPct: Int = 41,
        receivedAt: Long = now - 30_000,
    ) = BoxHealthWire(
        v = 1,
        domain = "home.alice.flagship.services",
        at = receivedAt,
        uptimeS = uptimeS,
        memTotalMB = 3_900,
        memAvailMB = 2_100,
        swapUsedMB = 0,
        oomKills = oomKills,
        daemon = BoxHealthDaemonWire(state = state, restarts = restarts, lastExit = lastExit),
        tunnel = tunnel,
        diskUsedPct = diskUsedPct,
        receivedAt = receivedAt,
    )

    @Test fun absentReportShowsNothing() {
        assertNull(ServerHealthVerdict.evaluate(null, now))
        assertNull(ServerHealthVerdict.evaluate(BoxHealthWire(), now))
    }

    @Test fun staleReportHidesEverythingElse() {
        val v = ServerHealthVerdict.evaluate(
            healthy(receivedAt = now - 7 * 60_000 - 5_000, oomKills = 2, tunnel = false),
            now,
        )!!
        assertFalse(v.ok)
        assertEquals(
            listOf("No health report for 7 min. The server itself may be off or frozen."),
            v.lines,
        )
    }

    @Test fun justUnderFiveMinutesIsNotStale() {
        val v = ServerHealthVerdict.evaluate(healthy(receivedAt = now - 299_999), now)!!
        assertTrue(v.ok)
    }

    @Test fun outOfMemoryAndRestarts() {
        val v = ServerHealthVerdict.evaluate(healthy(oomKills = 3, restarts = 4, lastExit = 137), now)!!
        assertFalse(v.ok)
        assertEquals(
            listOf(
                "Ran out of memory 3× since it started (2100 MB free of 3900 MB now).",
                "The server software restarted 4× since it started (last exit code 137).",
            ),
            v.lines,
        )
    }

    @Test fun failedDaemonTakesPrecedenceOverRestartCount() {
        val v = ServerHealthVerdict.evaluate(healthy(state = "failed", restarts = 5, lastExit = 1), now)!!
        assertEquals(
            listOf("The server software isn't running (failed; restarted 5×, last exit code 1)."),
            v.lines,
        )
    }

    @Test fun twoRestartsIsNotAnIssue() {
        assertTrue(ServerHealthVerdict.evaluate(healthy(restarts = 2), now)!!.ok)
    }

    @Test fun tunnelDown() {
        val v = ServerHealthVerdict.evaluate(healthy(tunnel = false), now)!!
        assertEquals(listOf("Can't reach the Flagship relay."), v.lines)
    }

    @Test fun diskFull() {
        assertEquals(listOf("Disk is 90% full."), ServerHealthVerdict.evaluate(healthy(diskUsedPct = 90), now)!!.lines)
        assertTrue(ServerHealthVerdict.evaluate(healthy(diskUsedPct = 89), now)!!.ok)
    }

    @Test fun healthyLineWithUptimeFormats() {
        val v = ServerHealthVerdict.evaluate(healthy(), now)!!
        assertTrue(v.ok)
        assertEquals(listOf("Healthy · 2100 MB free of 3900 MB · disk 41% · up 3d 4h"), v.lines)
        assertEquals("1d 0h", ServerHealthVerdict.uptime(86_400))
        assertEquals("2h 5m", ServerHealthVerdict.uptime(2 * 3_600 + 5 * 60 + 59))
        assertEquals("1h 0m", ServerHealthVerdict.uptime(3_600))
        assertEquals("59m", ServerHealthVerdict.uptime(3_599))
        assertEquals("0m", ServerHealthVerdict.uptime(30))
    }

    @Test fun podsEntryDecodesHealthAndToleratesItsAbsence() {
        val json = Json { ignoreUnknownKeys = true }
        val dir = json.decodeFromString(
            PodsDirectoryResponse.serializer(),
            """
            {"username":"alice","pods":[
              {"serverDomain":"a.alice.flagship.services","identityPubKey":"00",
               "health":{"v":1,"domain":"a.alice.flagship.services","at":1,"uptimeS":60,
                 "memTotalMB":3900,"memAvailMB":2100,"swapUsedMB":0,"oomKills":1,
                 "daemon":{"state":"failed","restarts":2,"lastExit":-1},
                 "tunnel":false,"diskUsedPct":12,"receivedAt":2}},
              {"serverDomain":"b.alice.flagship.services","identityPubKey":"00"}
            ]}
            """.trimIndent(),
        )
        val h = dir.pods[0].health!!
        assertEquals(1L, h.oomKills)
        assertEquals("failed", h.daemon!!.state)
        assertEquals(-1L, h.daemon!!.lastExit)
        assertEquals(false, h.tunnel)
        assertEquals(2L, h.receivedAt)
        assertNull(dir.pods[1].health)
    }
}
