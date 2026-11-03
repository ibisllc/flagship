package com.flagshipserver.app.core

import androidx.biometric.BiometricManager.Authenticators
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidVersionPolicyTest {
    private val p = AndroidVersionPolicy

    @Test fun warnsOnAndroid10To12Only() {
        for (sdk in 29..32) assertTrue("$sdk", p.warnOutdatedAndroid(sdk))
        for (sdk in 33..36) assertFalse("$sdk", p.warnOutdatedAndroid(sdk))
    }

    @Test fun recentsAndClipboardStandInsBelow33() {
        for (sdk in 29..32) {
            assertFalse(p.hasRecentsScreenshotControl(sdk))
            assertTrue(p.clipboardNeedsAutoClear(sdk))
            assertFalse(p.notificationPermissionIsRuntime(sdk))
        }
        assertTrue(p.hasRecentsScreenshotControl(33))
        assertFalse(p.clipboardNeedsAutoClear(33))
        assertTrue(p.notificationPermissionIsRuntime(33))
    }

    @Test fun keyAuthKeepsParametersFrom30() {
        assertEquals(AndroidVersionPolicy.KeyAuth.Parameters(0), p.keyAuth(30, 0))
        assertEquals(AndroidVersionPolicy.KeyAuth.Parameters(300), p.keyAuth(36, 300))
    }

    @Test fun keyAuthOnAndroid10IsAWindowOfTheSameLengthOrAShortOneForPerUseKeys() {
        assertEquals(AndroidVersionPolicy.KeyAuth.Window(300), p.keyAuth(29, 300))
        assertEquals(AndroidVersionPolicy.KeyAuth.Window(AndroidVersionPolicy.PER_USE_WINDOW_ON_API_29), p.keyAuth(29, 0))
        assertTrue(AndroidVersionPolicy.PER_USE_WINDOW_ON_API_29 in 1..30)
    }

    @Test fun promptOffersBiometricOrPinOnEveryVersion() {
        assertFalse(p.promptCanCarryKey(29))
        assertTrue(p.promptCanCarryKey(30))
        assertEquals(Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL, p.promptAuthenticators(29))
        assertEquals(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL, p.promptAuthenticators(30))
        assertEquals(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL, p.promptAuthenticators(36))
    }

    @Test fun copiedAuthenticatorConstantsMatchAndroidx() {
        assertEquals(Authenticators.BIOMETRIC_STRONG, AndroidVersionPolicy.BIOMETRIC_STRONG)
        assertEquals(Authenticators.BIOMETRIC_WEAK, AndroidVersionPolicy.BIOMETRIC_WEAK)
        assertEquals(Authenticators.DEVICE_CREDENTIAL, AndroidVersionPolicy.DEVICE_CREDENTIAL)
    }

    @Test fun olderApiBranches() {
        assertFalse(p.hasConfirmRejectHaptics(29)); assertTrue(p.hasConfirmRejectHaptics(30))
        assertFalse(p.keystoreHasX25519(30)); assertTrue(p.keystoreHasX25519(31))
        assertFalse(p.hasMutablePendingIntentFlag(30)); assertTrue(p.hasMutablePendingIntentFlag(31))
    }

    @Test fun theSliverShowsOnOldAndroidUnlessSnoozed() {
        val n = com.flagshipserver.app.ui.components.OutdatedAndroidNotice
        assertTrue(n.shows(29, now = 1_000, snoozedUntil = 0))
        assertFalse(n.shows(32, now = 1_000, snoozedUntil = 1_000 + n.SNOOZE_MS))
        assertTrue(n.shows(32, now = 1_000 + n.SNOOZE_MS, snoozedUntil = 1_000 + n.SNOOZE_MS))
        assertFalse(n.shows(33, now = 1_000, snoozedUntil = 0))
    }

    @Test fun readUpToStopsAtTheLimitOrTheEnd() {
        val data = ByteArray(5000) { it.toByte() }
        assertEquals(4096, TlsRelayEcho.readUpTo(data.inputStream(), 4096).size)
        assertTrue(TlsRelayEcho.readUpTo(data.inputStream(), 4096).contentEquals(data.copyOf(4096)))
        assertEquals(10, TlsRelayEcho.readUpTo(ByteArray(10).inputStream(), 4096).size)
    }
}
