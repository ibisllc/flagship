package com.flagshipserver.app.companion

import com.flagshipserver.companion.PodStatusSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionShortcutsTest {
    private val snap = PodStatusSnapshot(
        pods = (1..5).map { PodStatusSnapshot.Pod("p$it", "Server $it", "p$it.u.flagship.services", "online", it == 2) },
        controlHost = "gym.flagshipserver.com",
    )

    @Test fun approvalsFirstThenServersInOrder() {
        val specs = CompanionShortcuts.specs(snap, 4)
        assertEquals(listOf("approvals", "server:p1", "server:p2", "server:p3"), specs.map { it.id })
        assertEquals("https://gym.flagshipserver.com/app/secret-requests", specs[0].url)
        assertEquals("https://gym.flagshipserver.com/app/server?podId=p1", specs[1].url)
        assertEquals("Server 1", specs[1].shortLabel)
    }

    @Test fun noneWhenSignedOutOrNoServers() {
        assertTrue(CompanionShortcuts.specs(PodStatusSnapshot.EMPTY, 4).isEmpty())
        assertTrue(CompanionShortcuts.specs(snap, 0).isEmpty())
    }
}
