package com.flagshipserver.app.companion

import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.companion.PodStatusSnapshot
import com.flagshipserver.companion.SecurityAlert
import com.flagshipserver.companion.WatchContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class WatchBridgeTest {
    @Before fun setUp() = WatchBridge.resetForTest()
    @After fun tearDown() = WatchBridge.resetForTest()

    private val snapshot = PodStatusSnapshot(
        username = "u",
        pods = listOf(PodStatusSnapshot.Pod("home", "Home", "home.u.flagship.services", "online", true)),
    )

    @Test fun waitingBoxesComeFromTheServerList() {
        val pods = listOf(
            PodInfo(podId = "home", name = "Home", fqdn = "home.u.flagship.services", awaitingUnlock = true),
            PodInfo(podId = "office", name = "Office", fqdn = "office.u.flagship.services"),
            PodInfo(podId = "old", name = "Old", fqdn = "old.u.flagship.services", awaitingUnlock = true, revokedAt = 1),
        )
        val approvals = WatchBridge.approvalsFrom(pods)
        assertEquals(listOf("home.u.flagship.services"), approvals.map { it.serverFqdn })
        assertEquals("Home", approvals.single().serverName)
        assertEquals(null, approvals.single().requestId)
    }

    @Test fun eachHalfKeepsTheOthersAndSignOutClearsAll() {
        WatchBridge.updateStatus(snapshot, emptyList())
        WatchBridge.publishEvents(listOf(SecurityAlert(1, "device-added")))
        WatchBridge.updateProvision(ProvisionUpdate("S1", "S1", "Office", "installing"))
        val ctx = WatchBridge.current()
        assertEquals(snapshot, ctx.status)
        assertEquals(1, ctx.recentEvents.size)
        assertEquals("installing", ctx.provision?.phase)
        WatchBridge.updateStatus(PodStatusSnapshot(updatedAt = 5), emptyList())
        assertEquals(WatchContext.EMPTY, WatchBridge.current())
    }
}
