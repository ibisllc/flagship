// GYM Android, device bug M11: the screen turns off while the app wants its
// unlock prompt. The prompt used to be started on the stopped screen, failed
// silently ("Called after onSaveInstanceState()"), and the lock screen stayed
// on "Authenticating…" until the app was killed. Now the request waits for the
// screen to come back and always ends in an answer: on this emulator (no
// screen lock) the phone refuses the prompt, so the lock screen must show the
// reason and a tappable Unlock, never a stuck spinner.

package com.flagshipserver.app.gym

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test

class GymAppLockTest : GymBase() {

    private fun shell(cmd: String) {
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(cmd).close()
    }

    private fun unlockLabel(): String? =
        composeRule.onAllNodesWithTag("biometric-unlock-btn", useUnmergedTree = false)
            .fetchSemanticsNodes().firstOrNull()?.config
            ?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
            ?: composeRule.onAllNodesWithTag("biometric-unlock-btn", useUnmergedTree = true)
                .fetchSemanticsNodes().firstOrNull()?.config
                ?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }

    /** M12: a cold start of a signed-in device with the lock on opens on the
     *  lock screen, never on Home. The first launch persists a signed-in
     *  device; the second is a plain launcher start of it. */
    @Test
    fun aColdStartOfASignedInDeviceOpensLocked() {
        launch(tab = "home", realBiometrics = true, persistSession = true, username = "gym-lock")
        waitUntilExists("home-title")
        try {
            launchPlain()
            waitUntilExists("biometric-lock-screen", timeoutMs = 15_000)
            gymShot("cold-start-locked")
            composeRule.waitUntil(20_000) {
                val label = unlockLabel()
                label != null && !label.contains("Authenticating")
            }
        } finally {
            com.flagshipserver.app.keystore.Keystore.wipeAllProfiles()
        }
    }

    @Test
    fun theUnlockPromptAskedWhileTheScreenIsOffNeverSticks() {
        launch(tab = "home", realBiometrics = true)
        waitUntilExists("home-title")

        // Screen off: the activity stops, the app locks, and the lock screen
        // asks for its prompt while nothing is on screen.
        shell("input keyevent KEYCODE_SLEEP")
        Thread.sleep(2_000)
        shell("input keyevent KEYCODE_WAKEUP")
        shell("wm dismiss-keyguard")

        waitUntilExists("biometric-lock-screen", timeoutMs = 15_000)
        // The request ends (here: the phone has no screen lock to ask with),
        // and the button is back to a tappable Unlock.
        composeRule.waitUntil(20_000) {
            val label = unlockLabel()
            label != null && !label.contains("Authenticating")
        }
        gymShot("lock-after-wake")
        composeRule.onNodeWithTag("biometric-unlock-btn").assertExists()
        assertTrue(unlockLabel()!!.contains("Unlock"))
    }
}
