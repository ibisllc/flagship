package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InstallFinishTargetTest {
    private val apex = "gym.flagship.services"

    @Test fun wellFormedNeedsServerAndAccountInFrontOfTheApex() {
        assertTrue(InstallFinishTarget.isWellFormed("home2.harry.$apex", apex))
        assertTrue(InstallFinishTarget.isWellFormed("HOME2.Harry.$apex", apex))
        assertFalse(InstallFinishTarget.isWellFormed("server.$apex", apex))
        assertFalse(InstallFinishTarget.isWellFormed(apex, apex))
        assertFalse(InstallFinishTarget.isWellFormed("home.harry.flagship.services", apex))
        assertFalse(InstallFinishTarget.isWellFormed("..harry.$apex", apex))
    }

    @Test fun anEmptyRouteNeverInventsADomainFromTheName() {
        // The bug: no name and no domain on the route made "server.<apex>".
        assertNull(InstallFinishTarget.fqdn(resolved = null, fromRoute = "", serial = "S-2", pods = emptyList(), apex = apex))
    }

    @Test fun prefersTheResolvedDomainThenTheRouteThenTheOrdersPod() {
        val pod = PodInfo(
            podId = "pod-a", name = "a", fqdn = "a.harry.$apex",
            status = PodInfo.Status.PENDING, pendingAuthCodeSerial = "S-1",
        )
        assertEquals("r.harry.$apex", InstallFinishTarget.fqdn("r.harry.$apex", "q.harry.$apex", "S-1", listOf(pod), apex))
        assertEquals("q.harry.$apex", InstallFinishTarget.fqdn(null, "q.harry.$apex", "S-1", listOf(pod), apex))
        assertEquals("a.harry.$apex", InstallFinishTarget.fqdn("", "", "S-1", listOf(pod), apex))
        assertEquals("a.harry.$apex", InstallFinishTarget.fqdn("server.$apex", "", "S-1", listOf(pod), apex))
    }
}
