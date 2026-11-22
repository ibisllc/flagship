// Robolectric tests for RecoveryBannerStore — the persistent dismiss
// flag backing the Home post-creation backup-reminder banner. Mirror
// of FlagshipMobileTests/RecoveryBannerStoreTests.swift, with the
// same truth-table pinning the webapp predicate
// (apps/web/public/webapp/views/home.js).

package com.flagshipserver.app.core

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RecoveryBannerStoreTest {

    private fun freshStore(): RecoveryBannerStore {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val prefs = ctx.getSharedPreferences(
            "test.recoveryBanner.${System.nanoTime()}",
            android.content.Context.MODE_PRIVATE,
        )
        prefs.edit().clear().apply()
        return RecoveryBannerStore(prefs)
    }

    @Test fun shouldShow_whenNotEnrolledAndNotDismissed() {
        assertTrue(
            RecoveryBannerStore.shouldShow(
                hasCloudRecovery = false,
                dismissed = false,
            ),
        )
    }

    @Test fun hidden_whenEnrolled() {
        assertFalse(
            RecoveryBannerStore.shouldShow(
                hasCloudRecovery = true,
                dismissed = false,
            ),
        )
    }

    @Test fun hidden_afterDismiss_evenIfStillNotEnrolled() {
        assertFalse(
            RecoveryBannerStore.shouldShow(
                hasCloudRecovery = false,
                dismissed = true,
            ),
        )
    }

    @Test fun hidden_whenEnrolledEvenIfDismissed() {
        // Defensive: real enrolment clears hasCloudRecovery=true, so
        // the banner stays gone regardless of the persistent dismiss.
        assertFalse(
            RecoveryBannerStore.shouldShow(
                hasCloudRecovery = true,
                dismissed = true,
            ),
        )
    }

    @Test fun defaultDismissedIsFalse_onFreshInstall() {
        val store = freshStore()
        assertFalse(store.isDismissed())
    }

    @Test fun dismissPersistsAcrossInstances() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val prefsName = "test.recoveryBanner.persist.${System.nanoTime()}"
        val prefs = ctx.getSharedPreferences(prefsName, android.content.Context.MODE_PRIVATE)
        prefs.edit().clear().apply()

        val a = RecoveryBannerStore(prefs)
        assertFalse(a.isDismissed())
        a.setDismissed(true)

        // A fresh instance reading the SAME prefs sees the flip — this
        // is the next-launch behaviour the banner relies on.
        val b = RecoveryBannerStore(prefs)
        assertTrue(b.isDismissed())
    }

    // Snooze and the backup file card (owner, 2026-11-21).

    private fun prefs(name: String) =
        ApplicationProvider.getApplicationContext<android.content.Context>()
            .getSharedPreferences("test.recoveryBanner.$name.${System.nanoTime()}", android.content.Context.MODE_PRIVATE)
            .also { it.edit().clear().commit() }

    @Test fun dismissSnoozesForAWeek_thenTheCardComesBack() {
        val p = prefs("snooze")
        var clock = 1_800_000_000_000L
        RecoveryBannerStore(p) { clock }.setDismissed(true)
        clock += RecoveryBannerStore.SNOOZE_MS - 60_000
        assertTrue("still snoozed within the week", RecoveryBannerStore(p) { clock }.isDismissed())
        clock += 120_000
        assertFalse("back after a week", RecoveryBannerStore(p) { clock }.isDismissed())
    }

    @Test fun anOldForeverDismissal_becomesASnoozeFromToday() {
        val p = prefs("legacy")
        p.edit().putBoolean("dismissed.v1", true).commit()
        val day0 = 1_800_000_000_000L
        assertTrue(RecoveryBannerStore(p) { day0 }.isDismissed())
        assertFalse(p.contains("dismissed.v1"))
        assertFalse(RecoveryBannerStore(p) { day0 + RecoveryBannerStore.SNOOZE_MS + 1 }.isDismissed())
    }

    @Test fun backupFileCard_onlyAfterTheCloudCardWasPutOff() {
        assertFalse("the cloud card comes first", RecoveryBannerStore.shouldShowBackupFile(false, recoverySnoozed = false, hasBackupFile = false, dismissed = false))
        assertTrue(RecoveryBannerStore.shouldShowBackupFile(false, recoverySnoozed = true, hasBackupFile = false, dismissed = false))
        assertFalse("cloud recovery is enough", RecoveryBannerStore.shouldShowBackupFile(true, recoverySnoozed = true, hasBackupFile = false, dismissed = false))
        assertFalse("a saved file is enough", RecoveryBannerStore.shouldShowBackupFile(false, recoverySnoozed = true, hasBackupFile = true, dismissed = false))
        assertFalse(RecoveryBannerStore.shouldShowBackupFile(false, recoverySnoozed = true, hasBackupFile = false, dismissed = true))
    }

    @Test fun backupFileSnoozePersists() {
        val p = prefs("file")
        val clock = 1_800_000_000_000L
        val a = RecoveryBannerStore(p) { clock }
        assertFalse(a.isBackupFileDismissed())
        a.setBackupFileDismissed(true)
        assertTrue(RecoveryBannerStore(p) { clock }.isBackupFileDismissed())
        assertFalse(RecoveryBannerStore(p) { clock + RecoveryBannerStore.SNOOZE_MS + 1 }.isBackupFileDismissed())
    }
}
