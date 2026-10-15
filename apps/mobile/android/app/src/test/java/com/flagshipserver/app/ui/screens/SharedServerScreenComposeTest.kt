// The page another account gets for a server shared with it shows only what
// its level allows: the owner's sections are absent, not disabled.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import com.flagshipserver.app.api.AccessRequest
import com.flagshipserver.app.api.LastUpdate
import com.flagshipserver.app.api.ReleaseCatalogResponse
import com.flagshipserver.app.api.ReleaseEntry
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.core.BootShareRequest
import com.flagshipserver.app.core.BootSharePending
import com.flagshipserver.app.core.ServerShare
import com.flagshipserver.app.core.ShareSession
import com.flagshipserver.app.core.ShareStartup
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.ServerAppsViewModel
import com.flagshipserver.app.viewmodels.ShareCopy
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

    private var noticesTo: Boolean? = null
    private var updated = 0

    private fun show(state: SharedServerUi) {
        composeRule.setContent {
            FlagshipTheme {
                SharedServerContent(
                    serverName = "Home",
                    serverDomain = "home.alice.flagship.services",
                    ui = state,
                    onBack = {}, onApprove = {}, onAnswer = { _, _ -> }, onLeave = {}, onRetry = {},
                    onNotices = { noticesTo = it },
                    onUpdate = { updated++ },
                )
            }
        }
    }

    private val detail = ServerDetailResponse(
        serverFqdn = "home.alice.flagship.services", username = "alice", daemonVersion = "0.18.4",
        currentCommit = "1".repeat(40), startedAt = 0, uptimeMs = 60_000, serviceCount = 1, pairedSessionCount = 1,
        recentInstallEvents = emptyList(),
        lastUpdate = LastUpdate(outcome = "refused", at = 1, reason = "unendorsed"),
    )

    private val catalog = ReleaseCatalogResponse(
        checkedAt = 1,
        currentCommit = "1".repeat(40),
        latest = ReleaseEntry("2".repeat(40), "r2", "v1.2", "2026-10-14T00:00:00Z", "newer"),
        releases = listOf(
            ReleaseEntry("2".repeat(40), "r2", "v1.2", "2026-10-14T00:00:00Z", "newer"),
            ReleaseEntry("1".repeat(40), "r1", "v1.1", "2026-10-01T00:00:00Z", "current"),
        ),
    )

    @Test fun startupNoticesSwitchSaysWhatItTellsTheService() {
        show(ui(ServerShare.LEVEL_VIEW, startup = true))
        composeRule.onNodeWithText(ShareCopy.NOTICES_TITLE).assertIsDisplayed()
        composeRule.onNodeWithText(ShareCopy.NOTICES_LINE).assertIsDisplayed()
        composeRule.onNodeWithTag("shared-notices-switch").performClick()
        assert(noticesTo == true)
    }

    @Test fun noNoticesSwitchWithoutUnlockAtBoot() {
        show(ui(ServerShare.LEVEL_MANAGE, startup = false))
        composeRule.onNodeWithTag("shared-notices").assertDoesNotExist()
    }

    @Test fun manageWithCanUpdateOffersTheNewestEndorsedRelease() {
        show(ui(ServerShare.LEVEL_MANAGE, startup = false).copy(detail = detail, canUpdate = true, releases = catalog))
        composeRule.onNodeWithText("Running v1.1").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("The server refused the last update: Flagship's maintainers haven't endorsed that release.").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithTag("shared-update-button").performScrollTo().performClick()
        composeRule.onNodeWithText(ShareCopy.updateConfirm("Home")).assertIsDisplayed()
        composeRule.onNodeWithTag("shared-update-confirm").performClick()
        assert(updated == 1)
    }

    @Test fun viewNeverOffersAnUpdate() {
        show(ui(ServerShare.LEVEL_VIEW, startup = false).copy(detail = detail, canUpdate = true, releases = catalog))
        composeRule.onNodeWithTag("shared-update").assertDoesNotExist()
        composeRule.onNodeWithText("Update to v1.2").assertDoesNotExist()
    }

    @Test fun membersOnlyAppsSayAnInviteIsNeeded() {
        show(
            ui(ServerShare.LEVEL_VIEW, startup = false).copy(
                apps = listOf(
                    ServerAppsViewModel.Row("svc-1", "Notes", "notes.home.alice.flagship.services", "Running", membersOnly = true),
                    ServerAppsViewModel.Row("svc-2", "Blog", "blog.home.alice.flagship.services", "Running"),
                ),
            ),
        )
        composeRule.onNodeWithTag("shared-members-only-svc-1").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText(ShareCopy.MEMBERS_ONLY_HINT).assertIsDisplayed()
        composeRule.onNodeWithTag("shared-members-only-svc-2").assertDoesNotExist()
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
