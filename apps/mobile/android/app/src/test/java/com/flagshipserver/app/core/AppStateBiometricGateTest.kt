// C12 — Kotlin mirror of FlagshipMobileTests/BiometricGateLogicTests.swift.
// Pins AppState's launch-gate state machine + PrivacySettings
// persistence. The actual BiometricPrompt evaluation needs an
// instrumented test (real FragmentActivity); these run on plain JUnit.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AppStateBiometricGateTest {

    @Test fun defaultRequireBiometricIsFalse() {
        val s = AppState()
        assertFalse(s.requireBiometricAtLaunch.value)
    }

    @Test fun defaultIsUnlockedTrue_whenRequireIsFalse() {
        val s = AppState(requireBiometricAtLaunch = false)
        assertTrue(s.isUnlocked.value)
    }

    @Test fun defaultIsUnlockedFalse_whenRequireIsTrue() {
        val s = AppState(requireBiometricAtLaunch = true)
        assertFalse(s.isUnlocked.value)
    }

    @Test fun explicitIsUnlockedOverridesDefault() {
        val s = AppState(requireBiometricAtLaunch = true, isUnlocked = true)
        assertTrue(s.isUnlocked.value)
    }

    @Test fun markUnlocked_flipsLatchToTrue() {
        val s = AppState(requireBiometricAtLaunch = true)
        assertFalse(s.isUnlocked.value)
        s.markUnlocked()
        assertTrue(s.isUnlocked.value)
    }

    @Test fun relockForBackground_noOpsWhenNotRequired() {
        val s = AppState(requireBiometricAtLaunch = false)
        assertTrue(s.isUnlocked.value)
        s.relockForBackground()
        assertTrue(s.isUnlocked.value)
    }

    @Test fun relockForBackground_flipsLatchWhenRequired() {
        val s = AppState(requireBiometricAtLaunch = true, isUnlocked = true)
        s.relockForBackground()
        assertFalse(s.isUnlocked.value)
    }

    @Test fun signOut_dropsLatchToUnlocked() {
        val s = AppState(
            isPaired = true,
            currentUser = "u",
            requireBiometricAtLaunch = true,
            isUnlocked = false,
        )
        s.signOut()
        assertTrue(s.isUnlocked.value)
        // Preference stays — next launch re-arms.
        assertTrue(s.requireBiometricAtLaunch.value)
    }

    // ─── Tier 1: explicit LOCK ─────────────────────────────────────────

    @Test fun lock_reGatesWhenBiometricNotRequired() {
        // The whole point of Tier-1 LOCK: it re-gates even when the
        // auto-lock-at-launch preference is OFF. A user who never opted
        // into launch-lock can still deliberately lock the app.
        val s = AppState(requireBiometricAtLaunch = false)
        assertTrue(s.isUnlocked.value)
        s.lock()
        assertFalse(s.isUnlocked.value)
        // The preference is untouched — Lock is a runtime action, not a
        // settings change.
        assertFalse(s.requireBiometricAtLaunch.value)
    }

    @Test fun lock_thenMarkUnlocked_returns() {
        // Re-entry path: lock → biometric success → markUnlocked.
        val s = AppState(requireBiometricAtLaunch = false)
        s.lock()
        assertFalse(s.isUnlocked.value)
        s.markUnlocked()
        assertTrue(s.isUnlocked.value)
    }

    @Test fun lock_leavesSessionIntact() {
        // LOCK removes nothing — the session/identity stay exactly as
        // they were; only the visibility latch flips.
        val s = AppState(isPaired = true, currentUser = "alice")
        s.lock()
        assertFalse(s.isUnlocked.value)
        assertTrue(s.isPaired.value)
        assertEquals("alice", s.currentUser.value)
    }

    @Test fun setRequireBiometric_offClearsLatch() {
        // Turning the preference OFF must immediately release any
        // armed lock — otherwise the user would be stuck behind a
        // gate that they just disabled.
        val s = AppState(requireBiometricAtLaunch = true, isUnlocked = false)
        s.setRequireBiometricAtLaunch(false)
        assertTrue(s.isUnlocked.value)
        assertFalse(s.requireBiometricAtLaunch.value)
    }

    @Test fun privacySettings_persistsAcrossInstances() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val p1 = PrivacySettings.fromContext(ctx)
        // The unset default is now ON, so set an explicit value first.
        p1.setRequireBiometricAtLaunch(false)
        assertFalse(p1.requireBiometricAtLaunch.value)

        p1.setRequireBiometricAtLaunch(true)
        val p2 = PrivacySettings.fromContext(ctx)
        assertTrue(p2.requireBiometricAtLaunch.value)

        // Clean up so subsequent tests in the same JVM start clean.
        p2.setRequireBiometricAtLaunch(false)
    }

    @Test fun privacySettings_biometricDefaultsOn_whenUnset() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        // Wipe the prefs file so the key is genuinely unset.
        ctx.getSharedPreferences("flagship.privacy", Context.MODE_PRIVATE)
            .edit().clear().commit()
        val p = PrivacySettings.fromContext(ctx)
        assertTrue(p.requireBiometricAtLaunch.value)
        // Restore the clean state for the rest of the JVM run.
        p.setRequireBiometricAtLaunch(false)
    }

    @Test fun privacySettings_passphraseDefaultsOff_andPersists() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        ctx.getSharedPreferences("flagship.privacy", Context.MODE_PRIVATE)
            .edit().clear().commit()
        val p1 = PrivacySettings.fromContext(ctx)
        assertFalse(p1.requirePassphraseAtLaunch.value)
        p1.setRequirePassphraseAtLaunch(true)
        val p2 = PrivacySettings.fromContext(ctx)
        assertTrue(p2.requirePassphraseAtLaunch.value)
        p2.setRequirePassphraseAtLaunch(false)
    }
}
