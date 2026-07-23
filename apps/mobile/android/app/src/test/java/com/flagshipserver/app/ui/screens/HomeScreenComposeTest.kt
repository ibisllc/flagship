// Compose UI tests for the HomeScreen — exercise each LoadingState arm
// + the empty / non-empty pods path. Runs on Robolectric so we don't
// need an emulator.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
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
class HomeScreenComposeTest {
    @get:Rule val composeRule = createComposeRule()

    @Test fun emptyPods_showsAddYourFirstServerPrompt() {
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = LoadingState.Loading,
                    username = "harry",
                    accountDisplayName = "Harry's cloud",
                    deviceDisplayName = "Pixel",
                    pods = emptyList(),
                    leaderPodId = null,
                    onOpenPod = {},
                    onAddServer = {},
                    onSetLeader = {},
                    onRefresh = {},
                )
            }
        }
        composeRule.onNodeWithText("Add your first server").assertIsDisplayed()
        composeRule.onNodeWithText("Harry's cloud > Pixel").assertIsDisplayed()
        composeRule.onNodeWithText("Build a service").assertDoesNotExist()
        composeRule.onNodeWithText("YOUR SERVERS").assertDoesNotExist()
    }

    @Test fun loadedPods_rendersServerOverviewCard() {
        val pod = PodInfo(
            podId = "pod-x", name = "Home", fqdn = "home.harry.flagship.services",
            status = PodInfo.Status.ONLINE,
        )
        val detail = ServerDetailResponse(
            serverFqdn = "home.harry.flagship.services",
            username = "harry",
            daemonVersion = "0.18.4",
            startedAt = 0L,
            uptimeMs = 1000L,
            certSans = emptyList(),
            serviceCount = 3,
            pairedSessionCount = 2,
            recentInstallEvents = emptyList<RecentInstallEvent>(),
        )
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = LoadingState.Loaded(detail),
                    username = "harry",
                    deviceDisplayName = "Pixel",
                    pods = listOf(pod),
                    leaderPodId = "pod-x",
                    onOpenPod = {},
                    onAddServer = {},
                    onSetLeader = {},
                    onRefresh = {},
                )
            }
        }
        // The server renders as an FSListRow (name title + fqdn subtitle) and
        // the state-driven overview card repeats the fqdn — assert the
        // unambiguous greeting + that the fqdn appears at least once.
        composeRule.onNodeWithText("harry > Pixel").assertIsDisplayed()
        composeRule.onAllNodesWithText("home.harry.flagship.services")
            .onFirst().assertIsDisplayed()
        // The status pill now renders in the row's stacked `below` slot (under
        // the text), not the right-floated trailing slot — it still shows.
        composeRule.onAllNodesWithText("Online").onFirst().assertIsDisplayed()
    }

    @Test fun failedState_rendersErrorCardWithMessage() {
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = LoadingState.Failed("backend ate the request"),
                    username = "harry",
                    pods = emptyList(),
                    leaderPodId = null,
                    onOpenPod = {},
                    onAddServer = {},
                    onSetLeader = {},
                    onRefresh = {},
                )
            }
        }
        composeRule.onNodeWithText("backend ate the request").assertIsDisplayed()
    }
}
