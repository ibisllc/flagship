// The Backups section's wording and the schedule's local time ↔ UTC.
// Mirrors the iOS BackupsTextTests and the webapp's backup schedule tests.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.BackupCap
import com.flagshipserver.app.api.BackupLastRun
import com.flagshipserver.app.api.BackupPolicyState
import com.flagshipserver.app.api.BackupRunning
import com.flagshipserver.app.api.BackupSchedule
import com.flagshipserver.app.api.PeerBackupStatus
import com.flagshipserver.app.api.SavedBackup
import com.flagshipserver.app.api.SavedBackupsView
import com.flagshipserver.app.api.ServerArchiveApp
import com.flagshipserver.app.api.ServerArchiveLeftApp
import com.flagshipserver.app.api.ServerArchiveProgress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

class BackupsTextTest {
    private val gb = BackupsText.GB
    private val chicago = ZoneId.of("America/Chicago")
    private val tokyo = ZoneId.of("Asia/Tokyo")
    /** Friday 2026-10-16 12:00 UTC. */
    private val now = Instant.parse("2026-10-16T12:00:00Z")

    @Test fun dailyAtALocalTimeIsItsUtcMinute() {
        // 9:30 PM in Chicago (CDT, UTC-5) is 02:30 UTC.
        val s = BackupsText.toUtc("daily", BackupsText.LocalSlot(0, 21 * 60 + 30), 7, 4, chicago, now)
        assertEquals(BackupSchedule("daily", 2 * 60 + 30, 0, 7, 4), s)
        assertEquals(21 * 60 + 30, BackupsText.toLocal(s, chicago, now).minuteOfDay)
    }

    @Test fun weeklyAcrossMidnightMovesTheUtcWeekday() {
        // Monday 9:00 PM in Chicago is Tuesday 02:00 UTC.
        val west = BackupsText.toUtc("weekly", BackupsText.LocalSlot(1, 21 * 60), 7, 4, chicago, now)
        assertEquals(120, west.minuteOfDayUtc)
        assertEquals(2, west.weekdayUtc)
        assertEquals(BackupsText.LocalSlot(1, 21 * 60), BackupsText.toLocal(west, chicago, now))
        // Sunday 3:00 AM in Tokyo (UTC+9) is Saturday 18:00 UTC.
        val east = BackupsText.toUtc("weekly", BackupsText.LocalSlot(0, 3 * 60), 7, 4, tokyo, now)
        assertEquals(18 * 60, east.minuteOfDayUtc)
        assertEquals(6, east.weekdayUtc)
        assertEquals(BackupsText.LocalSlot(0, 3 * 60), BackupsText.toLocal(east, tokyo, now))
    }

    @Test fun everyLocalSlotRoundTrips() {
        for (zone in listOf(chicago, tokyo, ZoneId.of("UTC"), ZoneId.of("Asia/Kolkata"))) {
            for (w in 0..6) for (m in listOf(0, 15, 330, 719, 1425)) {
                val s = BackupsText.toUtc("weekly", BackupsText.LocalSlot(w, m), 1, 1, zone, now)
                assertEquals("$zone $w $m", BackupsText.LocalSlot(w, m), BackupsText.toLocal(s, zone, now))
            }
        }
    }

    @Test fun theScheduleLineIsInLocalTime() {
        val s = BackupSchedule("daily", 8 * 60, 0, 7, 4)
        assertEquals("Daily at 3:00 AM · keeps 7 daily and 4 weekly", BackupsText.scheduleLine(s, chicago, now, Locale.US).replace(' ', ' '))
        val w = BackupSchedule("weekly", 120, 2, 7, 4)
        assertEquals("Weekly on Monday at 9:00 PM · keeps 7 daily and 4 weekly", BackupsText.scheduleLine(w, chicago, now, Locale.US).replace(' ', ' '))
        assertEquals(BackupsText.SCHEDULE_OFF, BackupsText.scheduleLine(s.copy(frequency = "off"), chicago, now))
    }

    private fun backup(id: String, at: Long, trigger: String = "schedule", left: List<ServerArchiveLeftApp> = emptyList()) = SavedBackup(
        archiveId = id, createdAt = at, trigger = trigger, bytes = 3 * gb, sha256 = "ab".repeat(32), backupBytes = 2048,
        backupFileName = "home.flagship-backup", dataFileName = "home.flagship-data",
        bundleFileName = "home.flagship", bundleBytes = 3 * gb + 2064, bundleSha256 = "cd".repeat(32),
        apps = listOf(ServerArchiveApp("a", "Wiki"), ServerArchiveApp("b", "Plants")), left = left,
    )

    @Test fun statusNextAndFailedLines() {
        assertEquals("No backups yet.", BackupsText.statusLine(SavedBackupsView()))
        val running = SavedBackupsView(running = BackupRunning("x", progress = ServerArchiveProgress(1, 3, "Wiki")))
        assertEquals("Backing up… Wiki (1/3)", BackupsText.statusLine(running))
        val v = SavedBackupsView(backups = listOf(backup("a", 1_792_000_000_000)))
        assertTrue(BackupsText.statusLine(v), BackupsText.statusLine(v).startsWith("Last backup: ") && BackupsText.statusLine(v).endsWith(" · 3.0 GB"))
        assertEquals(
            "The last backup failed: needs about 12.0 GB, has 3.1 GB.",
            BackupsText.failedLine(SavedBackupsView(lastRun = BackupLastRun(1, false, "schedule", reason = "needs about 12.0 GB, has 3.1 GB"))),
        )
        assertNull(BackupsText.failedLine(SavedBackupsView(lastRun = BackupLastRun(1, true))))
        assertEquals(BackupsText.SCHEDULE_OFF, BackupsText.nextLine(SavedBackupsView(schedule = BackupSchedule(frequency = "off"))))
        assertNull("the keys are out: the waiting reason or the approve button", BackupsText.nextLine(SavedBackupsView(nextRunAt = null)))
        assertTrue(BackupsText.nextLine(SavedBackupsView(nextRunAt = 1_792_000_000_000))!!.startsWith("Next backup: "))
    }

    @Test fun rowsSayKindAppsAndWhatWasLeftOut() {
        val b = backup("a", 1_792_000_000_000, "now", listOf(ServerArchiveLeftApp("c", "Notes", "no source")))
        assertTrue(BackupsText.rowLine(b), BackupsText.rowLine(b).endsWith(" · 3.0 GB · Back up now · 2 apps"))
        assertTrue(BackupsText.rowLine(backup("a", 1)).contains(" · Scheduled · "))
        assertEquals("Left out: Notes", BackupsText.leftLine(b))
        assertNull(BackupsText.leftLine(backup("a", 1)))
    }

    @Test fun policyAndUsage() {
        assertEquals("Backup policy: Phone-side backups · up to 32 GB", BackupsText.policyLine(BackupPolicyState("phone", 32 * gb, 1)))
        assertEquals("Backup policy: Peer-distributed backups", BackupsText.policyLine(BackupPolicyState("peer", 0, 1)))
        assertEquals("Backup policy: No backups", BackupsText.policyLine(BackupPolicyState("none", 0, 1)))
        assertEquals("Backup policy: Not chosen yet", BackupsText.policyLine(BackupPolicyState()))
        val used = (3.2 * gb).toLong()
        assertEquals("Apps use 3.2 GB of 32 GB", BackupsText.usageLine("phone", BackupCap(limitBytes = 32 * gb, usedBytes = used)))
        assertEquals("Apps use 3.2 GB of 120 GB (a third of this server's disk)", BackupsText.usageLine("peer", BackupCap(limitBytes = 120 * gb, usedBytes = used)))
        assertEquals("Apps use 3.2 GB", BackupsText.usageLine("none", BackupCap(usedBytes = used)))
        assertNull(BackupsText.usageLine("phone", BackupCap(limitBytes = 32 * gb)))
        val peer = BackupsText.peerLines(PeerBackupStatus(state = "at-risk", healthyBricks = 9, totalBricks = 12, holders = 3, hostingBytes = 5 * gb, reason = "two holders are offline"))
        assertEquals(listOf("At risk: two holders are offline.", "9 of 12 pieces safe", "Held by 3 other servers", "Holds 5.0 GB for other servers"), peer)
    }

    @Test fun thePhoneReserveDefaultsToAQuarterOfItsFreeSpace() {
        assertEquals(16, BackupsText.defaultReserveGb(64 * gb + 5))
        assertEquals(2, BackupsText.defaultReserveGb(3 * gb))
        assertEquals(7, BackupsText.defaultReserveGb(31 * gb))
    }

    @Test fun onlyAnAdminDepositsAndOnlyWhenTheBoxAsks() {
        assertTrue(BackupsText.shouldDeposit(true, SavedBackupsView(keysWanted = 800)))
        assertFalse(BackupsText.shouldDeposit(true, SavedBackupsView(keysWanted = 0, keysLeft = 300)))
        assertFalse(BackupsText.shouldDeposit(false, SavedBackupsView(keysWanted = 800)))
        assertFalse(BackupsText.shouldDeposit(true, null))
    }
}
