// Welcome (no account) and the app lock share one footer: the big primary
// button, the secondary right below it, a gap, then "Patent Pending".

package com.flagshipserver.app.ui.components

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Dp
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.ui.screens.WelcomeScreen
import com.flagshipserver.app.ui.shell.BiometricLockScreen
import com.flagshipserver.app.ui.theme.FlagshipTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], qualifiers = "w411dp-h891dp")
class FrontDoorFooterComposeTest {
    @get:Rule val composeRule = createComposeRule()

    private fun assertFooter(primaryTag: String, primary: String, secondaryTag: String, secondary: String) {
        composeRule.onNodeWithTag(primaryTag).assertIsDisplayed()
        composeRule.onNodeWithTag(secondaryTag).assertIsDisplayed()
        composeRule.onNodeWithTag("patent-pending", useUnmergedTree = true).assertIsDisplayed().assertTextEquals("Patent Pending")
        val p = composeRule.onNodeWithTag(primaryTag).getUnclippedBoundsInRoot()
        val s = composeRule.onNodeWithTag(secondaryTag).getUnclippedBoundsInRoot()
        val pp = composeRule.onNodeWithTag("patent-pending", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertTrue("secondary sits right below the primary", s.top >= p.bottom && s.top - p.bottom < Dp(24f))
        assertTrue("a gap, then Patent Pending", pp.top - s.bottom >= Dp(24f))
        composeRule.onNodeWithTag(primaryTag).assertTextEquals(primary)
        composeRule.onNodeWithTag(secondaryTag).assertTextEquals(secondary)
    }

    @Test fun welcomeFooter() {
        composeRule.setContent { FlagshipTheme { WelcomeScreen(rememberNavController()) } }
        assertFooter("welcome-create", "Create your account", "welcome-connect", "Connect to an existing account")
    }

    @Test fun lockFooter() {
        composeRule.setContent { FlagshipTheme { BiometricLockScreen() } }
        assertFooter("biometric-unlock-btn", "Unlock", "lock-sign-out-btn", "Sign out")
    }
}
