// Compose UI tests for the HomeScreen — exercise each LoadingState arm
// + the empty / non-empty pods path. Runs on Robolectric so we don't
// need an emulator.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
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
        composeRule.onNodeWithText("Hi, harry.").assertIsDisplayed()
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
            appCount = 3,
            pairedSessionCount = 2,
            recentInstallEvents = emptyList<RecentInstallEvent>(),
        )
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = LoadingState.Loaded(detail),
                    username = "harry",
                    pods = listOf(pod),
                    leaderPodId = "pod-x",
                    onOpenPod = {},
                    onAddServer = {},
                    onSetLeader = {},
                    onRefresh = {},
                )
            }
        }
        composeRule.onNodeWithText("Home").assertIsDisplayed()
        composeRule.onNodeWithText("Everything is online.").assertIsDisplayed()
        composeRule.onNodeWithText("home.harry.flagship.services").assertIsDisplayed()
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
