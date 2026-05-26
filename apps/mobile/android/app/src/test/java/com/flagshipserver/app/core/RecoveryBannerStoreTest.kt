// Robolectric tests for RecoveryBannerStore — the persistent dismiss
// flag backing the Home post-creation backup-reminder banner. Mirror
// of FlagshipMobileTests/RecoveryBannerStoreTests.swift, with the
// same truth-table pinning the webapp predicate
// (apps/web/public/webapp/views/home.js).

package com.flagshipserver.app.core

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
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

    @Test fun defaultDismissedIsFalse_onFreshInstall() = runBlocking {
        val store = freshStore()
        assertFalse(store.dismissed.first())
    }

    @Test fun dismissPersistsAcrossInstances() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val prefsName = "test.recoveryBanner.persist.${System.nanoTime()}"
        val prefs = ctx.getSharedPreferences(prefsName, android.content.Context.MODE_PRIVATE)
        prefs.edit().clear().apply()

        val a = RecoveryBannerStore(prefs)
        assertFalse(a.dismissed.first())
        a.setDismissed(true)

        // A fresh instance reading the SAME prefs sees the flip — this
        // is the next-launch behaviour the banner relies on.
        val b = RecoveryBannerStore(prefs)
        assertTrue(b.dismissed.first())
    }
}
