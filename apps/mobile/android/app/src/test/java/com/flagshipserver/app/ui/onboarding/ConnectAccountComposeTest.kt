// Welcome offers "Create your account" + one "Connect to an existing account",
// whose page holds both ways in: the account name (sign in) and a pairing code
// (join). A pairing link typed as the name opens the join flow. Mirrors iOS
// OnboardingSmokeTests and the web gym's connect scenarios.

package com.flagshipserver.app.ui.onboarding

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.flagshipserver.app.core.ConnectInput
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.ui.theme.FlagshipTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], qualifiers = "w411dp-h891dp")
class ConnectAccountComposeTest {
    @get:Rule val composeRule = createComposeRule()

    private fun openConnectPage() {
        composeRule.setContent { FlagshipTheme { OnboardingFlow(onFinished = {}) } }
        composeRule.onNodeWithTag("welcome-create").assertIsDisplayed()
        composeRule.onAllNodesWithText("I already have an account").assertCountEquals(0)
        composeRule.onAllNodesWithText("Join with a pairing code").assertCountEquals(0)
        composeRule.onNodeWithTag("welcome-connect").performClick()
        composeRule.onNodeWithTag("connect-account").assertIsDisplayed()
    }

    @Test fun connectPageHoldsSignInAndPairing() {
        openConnectPage()
        composeRule.onNodeWithText("Sign in with your account name").assertIsDisplayed()
        composeRule.onNodeWithTag("connect-name-field").assertIsDisplayed()
        composeRule.onNodeWithTag("connect-name-continue").assertIsDisplayed()
        composeRule.onNodeWithTag("connect-or").assertIsDisplayed()
        composeRule.onNodeWithText("Join with a pairing code").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithTag("connect-scan").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithTag("connect-pair-field").performScrollTo().assertIsDisplayed()

        composeRule.onNodeWithTag("connect-pair-field").performTextInput("bright-maple")
        composeRule.onNodeWithTag("connect-pair-continue").performScrollTo().performClick()
        composeRule.onNodeWithText(ConnectInput.NAME_IN_CODE).performScrollTo().assertIsDisplayed()
    }

    @Test fun pairingLinkTypedAsTheNameOpensTheJoinFlow() {
        openConnectPage()
        composeRule.onNodeWithTag("connect-name-field")
            .performTextInput("https://${JoinLink.HOST}/join?sid=gym123&pk=${"A".repeat(43)}")
        composeRule.onNodeWithTag("connect-name-continue").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription("join-device").assertIsDisplayed()
    }

    @Test fun pastedCodeInTheCodeFieldOpensTheJoinFlow() {
        openConnectPage()
        composeRule.onNodeWithTag("connect-pair-field").performScrollTo()
            .performTextInput("sid=gym123&pk=${"A".repeat(43)}")
        composeRule.onNodeWithTag("connect-pair-continue").performScrollTo().performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription("join-device").assertIsDisplayed()
    }

    @Test fun scanACodeOpensTheScanner() {
        openConnectPage()
        composeRule.onNodeWithTag("connect-scan").performScrollTo().performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription("join-device-scan").assertIsDisplayed()
    }

    @Test fun anUnknownNameShowsTheInlineState() {
        openConnectPage()
        composeRule.onNodeWithTag("connect-name-field").performTextInput("nobody-here")
        composeRule.onNodeWithTag("connect-name-continue").performClick()
        composeRule.waitUntil(5_000) {
            composeRule.onAllNodesWithText("No Flagship account by that name").fetchSemanticsNodes().isNotEmpty()
        }
    }
}
