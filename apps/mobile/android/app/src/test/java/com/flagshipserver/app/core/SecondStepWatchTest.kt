package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecondStepWatchTest {
    private val home = "home.alice.flagship.services"

    @Test
    fun `reports the second step once, after the first-boot unlock was approved`() {
        val w = SecondStepWatch(windowMs = 600_000)
        assertEquals(emptyList<String>(), w.arrived(setOf(home), now = 0))
        w.arm("Home.Alice.flagship.services", now = 1_000)
        assertEquals(emptyList<String>(), w.arrived(emptySet(), now = 2_000))
        assertEquals(listOf(home), w.arrived(setOf(home), now = 81_000))
        assertEquals(emptyList<String>(), w.arrived(setOf(home), now = 90_000))
    }

    @Test
    fun `forgets a server whose second step never came`() {
        val w = SecondStepWatch(windowMs = 600_000)
        w.arm(home, now = 0)
        assertEquals(emptyList<String>(), w.arrived(setOf(home), now = 600_001))
    }

    @Test
    fun `a fresh order's Home row waiting for approval opens the approvals`() {
        val req = BoxRequest(nonceHex = "ab".repeat(32), serverDomain = home, type = SecretPurpose.UNLOCK_KEY, issuedAt = 1, expiresAt = 2)
        assertTrue(SecondStepWatch.opensApprovals("HOME.alice.flagship.services", neverOnline = true, inbox = mapOf(home to listOf(req))))
        assertFalse(SecondStepWatch.opensApprovals(home, neverOnline = true, inbox = emptyMap()))
        assertFalse(SecondStepWatch.opensApprovals(home, neverOnline = true, inbox = mapOf(home to emptyList())))
        // A running server waiting for a reboot unlock keeps its own page.
        assertFalse(SecondStepWatch.opensApprovals(home, neverOnline = false, inbox = mapOf(home to listOf(req))))
    }
}
