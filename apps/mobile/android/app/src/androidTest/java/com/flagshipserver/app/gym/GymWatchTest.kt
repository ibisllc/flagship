// GYM Android mock tier — the Wear OS companion's phone half: Settings →
// Account security → "Quick approve from watch" (the twin of iOS's "Quick
// approve from Apple Watch", handle `watch-delegate-toggle` shared with iOS).
// NO BACKEND: smoke mode seeds DemoFixtures and the mock `.com`, which accepts
// the delegate grant; the smoke seam passes the biometric prompt. The watch
// side (tile, complication, Approve) has no emulator pairing here; its
// projections and the phone's signed approval are covered by unit tests
// (WatchProtocolTest, WatchApprovalTest).

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import org.junit.Test

class GymWatchTest : GymBase() {

    private fun openAccountSecurity() {
        waitUntilExists("settings-open-account-security", timeoutMs = 15_000)
        composeRule.onNodeWithTag("settings-open-account-security").performScrollTo().performClick()
        composeRule.waitForIdle()
        composeRule.waitUntil(timeoutMillis = 15_000) {
            composeRule.onAllNodesWithContentDescription("account-security-enable-btn").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithContentDescription("account-security-disable-btn").fetchSemanticsNodes().isNotEmpty()
        }
    }

    /** Off by default; on registers the delegate grant (shows its renewal
     *  date); off revokes it. */
    @Test
    fun quickApproveFromWatchTogglesTheDelegateGrant() {
        launch(tab = "settings")
        openAccountSecurity()
        waitUntilExists("watch-delegate-toggle", timeoutMs = 15_000)
        val toggle = composeRule.onNodeWithTag("watch-delegate-toggle").performScrollTo()
        toggle.assertIsOff()
        gymShot("watch-quick-approve-off")

        toggle.performClick()
        waitUntilExists("watch-delegate-active", timeoutMs = 15_000)
        composeRule.onNodeWithTag("watch-delegate-toggle").assertIsOn()
        gymShot("watch-quick-approve-on")

        composeRule.onNodeWithTag("watch-delegate-toggle").performScrollTo().performClick()
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithTag("watch-delegate-active").fetchSemanticsNodes().isEmpty()
        }
        composeRule.onNodeWithTag("watch-delegate-toggle").assertIsOff()
    }
}
