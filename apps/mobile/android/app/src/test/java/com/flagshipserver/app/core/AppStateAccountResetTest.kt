// E7 mirror of FlagshipMobileTests/AppStateAccountResetTests.swift.
// The detector itself lives in HomeTab.LaunchedEffect (it needs
// Keystore access); these tests pin the AppState surface area the
// detector toggles + the banner reads.

package com.flagshipserver.app.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppStateAccountResetTest {

    @Test fun defaultAccountWasResetIsFalse() {
        val s = AppState()
        assertFalse(s.accountWasReset.value)
    }

    @Test fun canBeInitialisedTrue() {
        val s = AppState(accountWasReset = true)
        assertTrue(s.accountWasReset.value)
    }

    @Test fun setAccountWasReset_togglesFlag() {
        val s = AppState()
        assertFalse(s.accountWasReset.value)
        s.setAccountWasReset(true)
        assertTrue(s.accountWasReset.value)
        s.setAccountWasReset(false)
        assertFalse(s.accountWasReset.value)
    }

    @Test fun accountResetAndRecoveryNudge_areIndependent() {
        // Both signals can be true simultaneously; the visual
        // precedence (account-reset suppresses the recovery nudge)
        // is enforced in the composable, not in the model.
        val online = PodInfo(podId = "a", name = "A", fqdn = "a.u.flagship.services", status = PodInfo.Status.ONLINE)
        val s = AppState(
            isPaired = true,
            currentUser = "u",
            pods = listOf(online),
            hasCloudRecovery = false,
            accountWasReset = true,
        )
        assertTrue(s.shouldShowRecoveryNudgeNow())
        assertTrue(s.accountWasReset.value)
    }

    @Test fun signOut_doesNotClearAccountWasReset() {
        // Pins current behavior — the Welcome screen reads
        // accountWasReset after sign-out so it can show a "you were
        // signed out because your account was reset on another
        // device" hint (v1.1 follow-up). If we change this, update
        // the test.
        val s = AppState(
            isPaired = true,
            currentUser = "u",
            pods = emptyList(),
            accountWasReset = true,
        )
        s.signOut()
        assertFalse(s.isPaired.value)
        assertNull(s.currentUser.value)
        assertTrue(s.accountWasReset.value)
    }
}
