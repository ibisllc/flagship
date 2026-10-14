// The page another account gets for a server shared with it shows only what
// its level allows: the owner's sections are absent, not disabled.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import com.flagshipserver.app.api.AccessRequest
import com.flagshipserver.app.core.BootShareRequest
import com.flagshipserver.app.core.BootSharePending
import com.flagshipserver.app.core.ServerShare
import com.flagshipserver.app.core.ShareSession
import com.flagshipserver.app.core.ShareStartup
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.ServerAppsViewModel
import com.flagshipserver.app.viewmodels.SharedServerUi
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SharedServerScreenComposeTest {
    @get:Rule val composeRule = createComposeRule()

    private val ownerOnly = listOf(
        "Shared with", "Share this server", "Activity", "Danger zone", "Delete server", "Transfer", "Migrate",
        "Replace", "Power", "Preferred server", "Front page", "Boot unlock", "Dead-man lock", "Diagnostics", "Update",
        "Create app here", "Paired devices",
    )

    private fun ui(level: String, startup: Boolean) = SharedServerUi(
        phase = SharedServerUi.Phase.Ready,
        session = ShareSession("fss_x", Long.MAX_VALUE, level, unlockAtBoot = startup, seeAppData = false),
        apps = listOf(ServerAppsViewModel.Row("svc-1", "Notes", "notes.home.alice.flagship.services", "Running")),
        accessRequests = if (level == ServerShare.LEVEL_MANAGE) listOf(AccessRequest(serviceId = "svc-1", appName = "Notes", host = "api.example.com")) else emptyList(),
        startups = if (startup) {
            listOf(ShareStartup(BootSharePending(BootShareRequest("home.alice.flagship.services", "aa".repeat(32), "unlock-key", "bb".repeat(32), 1), "cc".repeat(64))))
        } else {
            emptyList()
        },
        canUnlock = startup,
    )

    private fun show(state: SharedServerUi) {
        composeRule.setContent {
            FlagshipTheme {
                SharedServerContent(
                    serverName = "Home",
                    serverDomain = "home.alice.flagship.services",
                    ui = state,
                    onBack = {}, onApprove = {}, onAnswer = { _, _ -> }, onLeave = {}, onRetry = {},
                )
            }
        }
    }

    @Test fun manageShowsItsSectionsAndNoOwnerSection() {
        show(ui(ServerShare.LEVEL_MANAGE, startup = true))
        composeRule.onNodeWithText("Home is starting").assertIsDisplayed()
        composeRule.onNodeWithText("Monitoring").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("Notes").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("Internet requests").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithTag("shared-leave").performScrollTo().assertIsDisplayed()
        ownerOnly.forEach { composeRule.onNodeWithText(it).assertDoesNotExist() }
    }

    @Test fun viewHidesManageSections() {
        show(ui(ServerShare.LEVEL_VIEW, startup = false))
        composeRule.onNodeWithText("Can view").assertIsDisplayed()
        composeRule.onNodeWithText("Internet requests").assertDoesNotExist()
        composeRule.onNodeWithTag("shared-startup").assertDoesNotExist()
        composeRule.onNodeWithTag("shared-leave").performScrollTo().assertIsDisplayed()
        ownerOnly.forEach { composeRule.onNodeWithText(it).assertDoesNotExist() }
    }
}
