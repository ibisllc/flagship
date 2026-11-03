package com.flagshipserver.app.core

import com.flagshipserver.app.core.AndroidVersionPolicy.KeyBinding as B
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
        for (strong in listOf(true, false)) {
            assertEquals(AndroidVersionPolicy.KeyAuth.Parameters(0), p.keyAuth(30, 0, strong))
            assertEquals(AndroidVersionPolicy.KeyAuth.Parameters(300), p.keyAuth(36, 300, strong))
        }
    }

    @Test fun perUseKeysOnAndroid10NeedAStrongBiometricPerUseAndNoWindow() {
        // M6: with a fingerprint enrolled, a per-use key is auth-per-use (no window any unlock opens).
        assertEquals(AndroidVersionPolicy.KeyAuth.PerUseBiometric, p.keyAuth(29, 0, strongBiometric = true))
        // Without one, the short window is the only way the PIN still works.
        assertEquals(AndroidVersionPolicy.KeyAuth.Window(AndroidVersionPolicy.PER_USE_WINDOW_ON_API_29), p.keyAuth(29, 0, strongBiometric = false))
        assertTrue(AndroidVersionPolicy.PER_USE_WINDOW_ON_API_29 in 1..30)
        // Keys that are a window anyway keep their length.
        assertEquals(AndroidVersionPolicy.KeyAuth.Window(300), p.keyAuth(29, 300, strongBiometric = true))
        assertEquals(AndroidVersionPolicy.KeyAuth.Window(300), p.keyAuth(29, 300, strongBiometric = false))
    }

    @Test fun aKeysBindingIsReadFromHowItWasMade() {
        assertEquals(B.WINDOW, p.keyBinding(29, 15, null))
        assertEquals(B.WINDOW, p.keyBinding(33, 15, true)) // an Android 10 window key after an upgrade
        assertEquals(B.PER_USE_BIOMETRIC_ONLY, p.keyBinding(29, -1, null))
        assertEquals(B.PER_USE_BIOMETRIC_ONLY, p.keyBinding(33, -1, false)) // made per use on Android 10, phone upgraded
        assertEquals(B.PER_USE_BIOMETRIC_OR_PIN, p.keyBinding(30, 0, true))
        assertEquals(B.PER_USE_BIOMETRIC_OR_PIN, p.keyBinding(36, -1, null))
    }

    @Test fun promptAuthenticatorsPerVersionAndKey() {
        // Android 10 with a fingerprint: strong biometric only, so a weak 2D face never answers the gate.
        assertEquals(Authenticators.BIOMETRIC_STRONG, p.promptAuthenticators(29, strongBiometric = true))
        assertEquals(Authenticators.BIOMETRIC_STRONG, p.promptAuthenticators(29, true, B.PER_USE_BIOMETRIC_ONLY))
        // Android 10 without one: the PIN must still work.
        assertEquals(Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL, p.promptAuthenticators(29, strongBiometric = false))
        for (sdk in listOf(30, 33, 36)) {
            assertEquals(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL, p.promptAuthenticators(sdk, false))
            assertEquals(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL, p.promptAuthenticators(sdk, true, B.PER_USE_BIOMETRIC_OR_PIN))
            // An Android 10 per-use key after an upgrade: the PIN would never authorize it.
            assertEquals(Authenticators.BIOMETRIC_STRONG, p.promptAuthenticators(sdk, true, B.PER_USE_BIOMETRIC_ONLY))
        }
    }

    @Test fun promptCarriesAKeyFrom30OrWithAFingerprintOnAndroid10() {
        assertFalse(p.promptCanCarryKey(29, strongBiometric = false))
        assertTrue(p.promptCanCarryKey(29, strongBiometric = true))
        assertTrue(p.promptCanCarryKey(30, strongBiometric = false))
        assertTrue(p.canMakePerUseKey(29, true)); assertFalse(p.canMakePerUseKey(29, false)); assertTrue(p.canMakePerUseKey(31, false))
    }

    @Test fun suggestsAFingerprintOnlyOnAndroid10WithoutOne() {
        assertTrue(p.suggestAddingFingerprint(29, strongBiometric = false))
        assertFalse(p.suggestAddingFingerprint(29, strongBiometric = true))
        for (sdk in 30..36) assertFalse(p.suggestAddingFingerprint(sdk, strongBiometric = false))
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
