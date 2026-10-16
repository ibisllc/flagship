package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdminOrderGateTest {
    /** The webapp's rule (lib/addServerGate.js): the admin root, or a demo account. */
    @Test
    fun adminRootOrDemoAccount() {
        assertTrue(AdminOrderGate.allows(holdsAdminRoot = true, isDemoAccount = false))
        assertTrue(AdminOrderGate.allows(holdsAdminRoot = false, isDemoAccount = true))
        assertFalse(AdminOrderGate.allows(holdsAdminRoot = false, isDemoAccount = false))
    }

    @Test
    fun sentencesMatchTheOtherApps() {
        assertEquals("Only an admin device can remove an app.", AdminOrderGate.UNINSTALL)
        assertEquals("Only an admin device can change where this app runs.", AdminOrderGate.RUNS_ON)
    }
}
