// GYM Android onboarding: Welcome offers "Create your account" + one "Connect
// to an existing account"; its page holds sign-in by account name and joining
// with a pairing code. Starts unpaired against the mock clients
// (flagship.smokeOnboarding). Mirror of iOS OnboardingSmokeTests' connect tests.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.flagshipserver.app.core.ConnectInput
import com.flagshipserver.app.core.JoinLink
import org.junit.Test

class GymOnboardingTest : GymBase() {

    private fun openConnectPage() {
        launch(tab = "home", onboarding = true)
        waitUntilExists("welcome-connect")
        composeRule.onNodeWithTag("welcome-create").assertIsDisplayed()
        composeRule.onAllNodesWithText("I already have an account").assertCountEquals(0)
        composeRule.onAllNodesWithText("Join with a pairing code").assertCountEquals(0)
        gymShot("welcome")
        composeRule.onNodeWithTag("welcome-connect").performClick()
        waitUntilExists("connect-account")
    }

    @Test
    fun connectPageHoldsSignInAndPairing() {
        openConnectPage()
        composeRule.onNodeWithTag("connect-name-field").assertIsDisplayed()
        composeRule.onNodeWithTag("connect-or").assertIsDisplayed()
        composeRule.onNodeWithTag("connect-scan").performScrollTo().assertIsDisplayed()
        gymShot("connect-account")
        composeRule.onNodeWithTag("connect-pair-field").performScrollTo().typeText("bright-maple")
        composeRule.onNodeWithTag("connect-pair-continue").performScrollTo().performClick()
        // The hint arrives a frame or more after the tap on a busy emulator.
        waitText(ConnectInput.NAME_IN_CODE, 15_000)
        composeRule.onNodeWithText(ConnectInput.NAME_IN_CODE).performScrollTo().assertIsDisplayed()
    }

    /** The lock screen ends like Welcome: Unlock, Sign out right below, a
     *  gap, then Patent Pending above the navigation bar. */
    @Test
    fun lockScreenSharesTheWelcomeFooter() {
        launch(tab = "settings")
        waitUntilExists("settings-lock-btn")
        composeRule.onNodeWithTag("settings-lock-btn").performScrollTo().performClick()
        waitUntilExists("biometric-unlock-btn")
        composeRule.onNodeWithTag("biometric-unlock-btn").assertIsDisplayed()
        composeRule.onNodeWithTag("lock-sign-out-btn").assertIsDisplayed()
        composeRule.onNodeWithTag("patent-pending", useUnmergedTree = true).assertIsDisplayed()
        gymShot("lock-screen")
    }

    @Test
    fun pairingLinkTypedAsTheNameOpensJoin() {
        openConnectPage()
        composeRule.onNodeWithTag("connect-name-field")
            .typeText("https://${JoinLink.HOST}/join?sid=gym123&pk=${"A".repeat(43)}")
        composeRule.onNodeWithTag("connect-name-continue").performClick()
        waitUntilExistsDesc("join-device")
        gymShot("connect-link-to-join")
    }
}
