// Compose UI test for ProvidersScreen. Robolectric host so we don't need an
// emulator; pins the provider rows + Save CTA so a refactor that drops one is
// caught. (Relocated out of the deleted AddServerChooserComposeTest.kt when the
// add-server chooser was removed — Slice A.)

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.flagshipserver.app.ui.theme.FlagshipTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ProvidersComposeTest {
    @get:Rule val composeRule = createComposeRule()

    @Test fun rendersProviderRowsAndSaveCta() {
        composeRule.setContent {
            FlagshipTheme {
                ProvidersScreen(nav = androidx.navigation.compose.rememberNavController())
            }
        }
        // Provider rows live in a scrollable column; assertExists pins their
        // presence in the tree without requiring them to fit the current
        // viewport (the test runner's window can be tiny).
        composeRule.onNodeWithText("AI providers").assertExists()
        composeRule.onNodeWithText("Anthropic Claude").assertExists()
        composeRule.onNodeWithText("OpenAI").assertExists()
        composeRule.onNodeWithText("Google AI").assertExists()
        composeRule.onNodeWithText("Save").assertExists()
    }
}
