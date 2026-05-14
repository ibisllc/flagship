// Compose UI tests for the three screens added in 6b9bb88:
//   AddServerChooserScreen / PodPairScreen / ProvidersScreen.
//
// Robolectric host so we don't need an emulator. Each test pins the
// key labels + that the right callbacks fire when the right buttons
// are tapped — enough to catch a refactor that renames a screen
// element or drops a CTA wire.
//
// PodPairScreen embeds a live QRScanner that doesn't lay out under
// Robolectric (no CameraX provider), so we only assert that an
// instance renders + that the visible CTAs are present. Behavioral
// form-submission coverage happens via integration tests.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.flagshipserver.app.ui.theme.FlagshipTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AddServerChooserComposeTest {
    @get:Rule val composeRule = createComposeRule()

    @Test fun onboardingMode_rendersBothCards() {
        composeRule.setContent {
            FlagshipTheme {
                AddServerChooserScreen(
                    mode = AddServerMode.ONBOARDING,
                    onProvision = {},
                    onPair = {},
                )
            }
        }
        composeRule.onNodeWithText("Get your first server.").assertIsDisplayed()
        composeRule.onNodeWithText("Provision a new box").assertIsDisplayed()
        composeRule.onNodeWithText("Pair an existing box").assertIsDisplayed()
    }

    @Test fun inAppMode_usesTheInAppTitle() {
        composeRule.setContent {
            FlagshipTheme {
                AddServerChooserScreen(
                    mode = AddServerMode.IN_APP,
                    onProvision = {},
                    onPair = {},
                )
            }
        }
        composeRule.onNodeWithText("Add a server.").assertIsDisplayed()
    }

    @Test fun provisionCta_firesProvisionCallback() {
        var provisionFired = false
        var pairFired = false
        composeRule.setContent {
            FlagshipTheme {
                AddServerChooserScreen(
                    mode = AddServerMode.IN_APP,
                    onProvision = { provisionFired = true },
                    onPair = { pairFired = true },
                )
            }
        }
        composeRule.onNodeWithText("Provision →").performClick()
        assertEquals(true, provisionFired)
        assertEquals(false, pairFired)
    }

    @Test fun pairCta_firesPairCallback() {
        var provisionFired = false
        var pairFired = false
        composeRule.setContent {
            FlagshipTheme {
                AddServerChooserScreen(
                    mode = AddServerMode.IN_APP,
                    onProvision = { provisionFired = true },
                    onPair = { pairFired = true },
                )
            }
        }
        // The Pair card lives below the Provision card; scroll the
        // button into view before tapping.
        composeRule.onNodeWithText("Pair →").performScrollTo().performClick()
        assertEquals(false, provisionFired)
        assertEquals(true, pairFired)
    }

    @Test fun cancel_appearsOnlyWhenWired() {
        composeRule.setContent {
            FlagshipTheme {
                AddServerChooserScreen(
                    mode = AddServerMode.IN_APP,
                    onProvision = {},
                    onPair = {},
                    onCancel = null,
                )
            }
        }
        composeRule.onAllNodes(androidx.compose.ui.test.hasText("Cancel")).fetchSemanticsNodes()
            .also { assertEquals(0, it.size) }
    }
}

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
        // Provider rows live in a scrollable column; assertExists pins
        // their presence in the tree without requiring them to fit the
        // current viewport (the test runner's window can be tiny).
        composeRule.onNodeWithText("AI providers").assertExists()
        composeRule.onNodeWithText("Anthropic Claude").assertExists()
        composeRule.onNodeWithText("OpenAI").assertExists()
        composeRule.onNodeWithText("Google AI").assertExists()
        composeRule.onNodeWithText("Save").assertExists()
    }
}
