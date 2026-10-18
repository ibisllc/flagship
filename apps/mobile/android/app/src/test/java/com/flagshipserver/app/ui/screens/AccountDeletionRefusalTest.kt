package com.flagshipserver.app.ui.screens

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** `.com` answers the delete with 403 `code: other-devices-remain` while a second device is on the account. */
class AccountDeletionRefusalTest {
    @Test
    fun theCodeTheSentenceAndTheOldWordingAllMeanAnotherDevice() {
        assertTrue(otherDevicesRemain("""{"error":"x","code":"other-devices-remain","otherDevices":1}"""))
        assertTrue(otherDevicesRemain("Another device is still on this account. Remove it in Settings, Trusted devices, then delete the account."))
        assertTrue(otherDevicesRemain("not the last device: other active devices exist"))
    }

    @Test
    fun otherRefusalsAreNotAnotherDevice() {
        assertFalse(otherDevicesRemain("invalid accountSelfDelete signature"))
        assertFalse(otherDevicesRemain("stale request"))
    }
}
