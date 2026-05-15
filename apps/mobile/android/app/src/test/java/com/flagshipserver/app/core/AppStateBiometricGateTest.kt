// C12 — Kotlin mirror of FlagshipMobileTests/BiometricGateLogicTests.swift.
// Pins AppState's launch-gate state machine + PrivacySettings
// persistence. The actual BiometricPrompt evaluation needs an
// instrumented test (real FragmentActivity); these run on plain JUnit.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
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
        // Default false on a fresh prefs file.
        // (May survive between tests — reset explicitly.)
        p1.setRequireBiometricAtLaunch(false)
        assertFalse(p1.requireBiometricAtLaunch.value)

        p1.setRequireBiometricAtLaunch(true)
        val p2 = PrivacySettings.fromContext(ctx)
        assertTrue(p2.requireBiometricAtLaunch.value)

        // Clean up so subsequent tests in the same JVM start clean.
        p2.setRequireBiometricAtLaunch(false)
    }
}
