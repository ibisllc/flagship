// App lock (device bugs M11/M12): with "Lock with biometrics" on, a cold
// start of a signed-in device and a return from the background both open
// locked; only an unlock (or turning the lock off) opens the app.

package com.flagshipserver.app.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockStateTest {
    @Test fun aColdStartWithTheLockOnOpensLocked() {
        val app = AppState(requireBiometricAtLaunch = true)
        app.restorePersistedSession("nimble-caracal")
        assertTrue(app.isPaired.value)
        assertFalse(app.isUnlocked.value)
    }

    @Test fun aColdStartWithTheLockOffOpensUnlocked() {
        val app = AppState(requireBiometricAtLaunch = false)
        app.restorePersistedSession("nimble-caracal")
        assertTrue(app.isUnlocked.value)
    }

    @Test fun comingBackFromTheBackgroundLocksAgain() {
        val app = AppState(requireBiometricAtLaunch = true)
        app.restorePersistedSession("nimble-caracal")
        app.markUnlocked()
        app.relockForBackground()
        assertFalse(app.isUnlocked.value)
    }
}
