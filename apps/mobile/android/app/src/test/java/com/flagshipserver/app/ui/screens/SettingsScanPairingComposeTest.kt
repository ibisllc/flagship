// Settings offers "Scan a pairing code" while signed in, as iOS and the webapp
// do: this phone can join another account (or a second one of the owner's).

package com.flagshipserver.app.ui.screens

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.ui.theme.FlagshipTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SettingsScanPairingComposeTest {
    @get:Rule val composeRule = createComposeRule()

    @Test fun scanAPairingCodeOpensTheJoinScanner() {
        composeRule.setContent {
            FlagshipTheme {
                val nav = rememberNavController()
                NavHost(nav, startDestination = "settings-root") {
                    composable("settings-root") { SettingsScreen(nav) }
                    composable("join-device-scan") { Text("join scanner") }
                }
            }
        }
        composeRule.onNodeWithText("Scan a pairing code").performScrollTo().performClick()
        composeRule.onNodeWithText("join scanner").assertIsDisplayed()
    }
}
