// The marketplace is off in 0.4 (owner, 2026-11-19; release/version.json "marketplace"):
// the empty Services screen and the build chooser show no way into it. 0.5 turns it on.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.BuildConfig
import com.flagshipserver.app.ui.theme.FlagshipTheme
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class MarketplaceOffComposeTest {
    @get:Rule val composeRule = createComposeRule()

    @Test fun theReleaseSwitchIsOffIn04() {
        assertFalse(BuildConfig.MARKETPLACE)
    }

    @Test fun emptyServices_offersBuildOnly() {
        composeRule.setContent { FlagshipTheme { NoServicesYetState(onBuild = {}, onBrowseMarketplace = {}) } }
        composeRule.onNodeWithTag("services-build-cta").assertIsDisplayed()
        composeRule.onNodeWithTag("services-browse-marketplace").assertDoesNotExist()
        composeRule.onNodeWithText("Browse marketplace").assertDoesNotExist()
    }

    @Test fun emptyServices_offersTheMarketplaceWhenOn() {
        composeRule.setContent { FlagshipTheme { NoServicesYetState(onBuild = {}, onBrowseMarketplace = {}, marketplace = true) } }
        composeRule.onNodeWithTag("services-browse-marketplace").assertIsDisplayed()
    }

    @Test fun buildChooser_hasThreeTilesAndNoMarketplace() {
        composeRule.setContent { FlagshipTheme { BuildSourceChooserScreen(rememberNavController()) } }
        composeRule.onNodeWithTag("build-src-scratch").assertExists()
        composeRule.onNodeWithTag("build-src-git").assertExists()
        composeRule.onNodeWithTag("build-src-mcp").assertExists()
        composeRule.onNodeWithTag("build-src-market").assertDoesNotExist()
        composeRule.onNodeWithText("Get from the marketplace").assertDoesNotExist()
    }
}
