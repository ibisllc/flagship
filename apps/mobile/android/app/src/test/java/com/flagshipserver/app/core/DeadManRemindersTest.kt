// Pure reminder-offset math: T-6h/T-1h/T-15m relative to lease expiry, with
// past lead-times dropped. No Android Context needed.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeadManRemindersTest {

    private val H = 3600_000L
    private val M = 60_000L

    @Test fun fullDayWindow_schedulesAllThree_ascending() {
        val now = 0L
        val expiry = 24 * H
        val due = DeadManReminders.due(expiry, now)
        assertEquals(3, due.size)
        assertEquals(listOf(expiry - 6 * H, expiry - 1 * H, expiry - 15 * M), due.map { it.fireAt })
        // ascending
        assertTrue(due[0].fireAt < due[1].fireAt && due[1].fireAt < due[2].fireAt)
    }

    @Test fun shortWindow_dropsPastLeadTimes() {
        val now = 0L
        val expiry = 30 * M // only the 15-minute reminder is still in the future
        val due = DeadManReminders.due(expiry, now)
        assertEquals(1, due.size)
        assertEquals(expiry - 15 * M, due.first().fireAt)
        assertEquals("15 minutes left", due.first().label)
    }

    @Test fun tinyWindow_noRemindersWhenAllPast() {
        val now = 0L
        val expiry = 10 * M // even T-15m is already past
        assertTrue(DeadManReminders.due(expiry, now).isEmpty())
    }

    @Test fun remainingLabel_formatsHoursAndMinutes() {
        assertEquals("23h 45m left", DeadManReminders.remainingLabel(24 * H - 15 * M, 0))
        assertEquals("14m left", DeadManReminders.remainingLabel(14 * M, 0))
        assertEquals("expired", DeadManReminders.remainingLabel(0, 0))
        assertEquals("expired", DeadManReminders.remainingLabel(-5, 0))
    }
}
