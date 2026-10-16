// A new live account with no server: Home shows its empty state and never a
// "couldn't load" card, a fixture server card or a "not paired" error (device
// bug 2026-10-16). Mirrors iOS HomeScreen.shouldShowLoadError (always false).

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import com.flagshipserver.app.api.RecentInstallEvent
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.LoadingState
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class HomeNoServerTest {
    @get:Rule val composeRule = createComposeRule()

    private fun setHome(state: LoadingState<ServerDetailResponse>, pods: List<PodInfo>) {
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = state,
                    username = "nimble-caracal",
                    pods = pods,
                    onOpenPod = {},
                    onAddServer = {},
                    onMakeLeader = {},
                    onRefresh = {},
                )
            }
        }
    }

    private fun detail(events: List<RecentInstallEvent> = emptyList()) = ServerDetailResponse(
        serverFqdn = "home.bright-maple.flagship.services", username = "bright-maple",
        daemonVersion = "0.18.4", startedAt = 0, uptimeMs = 0, serviceCount = 1,
        pairedSessionCount = 0, recentInstallEvents = events,
    )

    @Test fun aFailedLoadWithNoServerShowsOnlyTheEmptyState() {
        setHome(LoadingState.Failed("This device isn't paired with this server yet."), emptyList())
        composeRule.onNodeWithTag("home-empty-state").assertExists()
        composeRule.onNodeWithText("Couldn't load").assertDoesNotExist()
        composeRule.onNodeWithText("paired", substring = true).assertDoesNotExist()
    }

    @Test fun aServerDetailIsNeverShownWithoutAServer() {
        setHome(LoadingState.Loaded(detail()), emptyList())
        composeRule.onNodeWithText("bright-maple", substring = true).assertDoesNotExist()
        composeRule.onNodeWithTag("home-recent-activity").assertDoesNotExist()
    }

    @Test fun withAServerTheRecentDeploysShow() {
        val pod = PodInfo(podId = "a", name = "home", fqdn = "home.harry.flagship.services", status = PodInfo.Status.ONLINE)
        setHome(LoadingState.Loaded(detail(listOf(RecentInstallEvent(1, "installed", "harry--notes")))), listOf(pod))
        composeRule.onNodeWithTag("home-recent-activity").assertExists()
        composeRule.onNodeWithText("Deployed harry--notes").assertExists()
    }
}
