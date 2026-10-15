package com.flagshipserver.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WatchProtocolTest {
    private fun pod(id: String, status: String = "online") =
        PodStatusSnapshot.Pod(id, id, "$id.u.flagship.services", status, false)

    @Test fun wireRoundTrips() {
        val ctx = WatchContext(
            status = PodStatusSnapshot("u", listOf(pod("home"))),
            pendingApprovals = listOf(PendingApproval(null, "home.u.flagship.services", "Home")),
            recentEvents = listOf(SecurityAlert(3, "device-added", postedAt = 9)),
            provision = ProvisionTimeline("S1", "Office", null, "sealing"),
            updatedAt = 1,
        )
        assertEquals(ctx, WatchContext.decode(ctx.encode()))
        assertEquals(WatchContext.EMPTY, WatchContext.decode("nope"))
        val cmd = ApproveCommand(requestId = "r", serverFqdn = "home.u.flagship.services")
        assertEquals(cmd, ApproveCommand.decode(cmd.encode()))
        assertEquals(ApproveCommand.KIND, cmd.kind)
        val reply = ApproveReply("home.u.flagship.services", ok = false, errorMessage = "x")
        assertEquals(reply, ApproveReply.decode(reply.encode()))
        assertNull(ApproveReply.decode("{".toByteArray()))
    }

    @Test fun approvalsOnePerBoxLongestWaitingFirst() {
        val ctx = WatchContext(
            pendingApprovals = listOf(
                PendingApproval(null, "b.u.flagship.services", requestedAt = 0),
                PendingApproval("r2", "B.u.flagship.services", requestedAt = 5),
                PendingApproval("r1", "a.u.flagship.services", requestedAt = 2),
            ),
        )
        assertEquals(listOf("r1", "r2"), WatchProjection.approvals(ctx).map { it.requestId })
    }

    @Test fun eventsNewestFirstDedupedAndTrimmed() {
        val ctx = WatchContext(recentEvents = (1..8).map { SecurityAlert(it, "device-added") } + SecurityAlert(8, "dup"))
        assertEquals(listOf(8, 7, 6, 5, 4), WatchProjection.events(ctx).map { it.seq })
        assertEquals("Added device", WatchProjection.eventLabel("device-added"))
        assertEquals("Something new", WatchProjection.eventLabel("something-new"))
    }

    @Test fun tileLines() {
        val pods = PodStatusSnapshot("u", listOf(pod("a").copy(name = "Home", isLeader = true), pod("b")))
        assertEquals(WatchProjection.TileLines("2/2 up", "Leader: Home", false), WatchProjection.tileLines(WatchContext(status = pods)))
        val one = WatchContext(status = pods, pendingApprovals = listOf(PendingApproval(null, "a.u.flagship.services", "Home")))
        assertEquals(WatchProjection.TileLines("1 waiting", "Home", true), WatchProjection.tileLines(one))
        val failed = one.copy(provision = ProvisionTimeline("S", "Office", phase = "error"))
        assertEquals(WatchProjection.TileLines("Problem", "Office", true), WatchProjection.tileLines(failed))
        assertEquals(WatchProjection.TileLines("No servers", null, false), WatchProjection.tileLines(WatchContext.EMPTY))
    }

    @Test fun shortTextPrefersInstallThenWaitingThenCount() {
        val pods = PodStatusSnapshot("u", listOf(pod("a"), pod("b", "offline")))
        assertEquals("No servers", WatchProjection.shortText(WatchContext.EMPTY))
        assertEquals("1/2 up", WatchProjection.shortText(WatchContext(status = pods)))
        val waiting = WatchContext(status = pods, pendingApprovals = listOf(PendingApproval(null, "a.u.flagship.services")))
        assertEquals("1 waiting", WatchProjection.shortText(waiting))
        val installing = waiting.copy(provision = ProvisionTimeline("S", phase = "sealing"))
        assertEquals("Sealing", WatchProjection.shortText(installing))
        assertEquals(6f / 9f, WatchProjection.provisionFraction(installing)!!, 0.001f)
        val done = waiting.copy(provision = ProvisionTimeline("S", phase = "live"))
        assertEquals("1 waiting", WatchProjection.shortText(done))
        assertNull(WatchProjection.provisionFraction(done))
    }
}
