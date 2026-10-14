// Compose UI tests for the HomeScreen — exercise each LoadingState arm
// + the empty / non-empty pods path. Runs on Robolectric so we don't
// need an emulator.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
                    onMakeLeader = {},
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
                    onMakeLeader = {},
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
                    onMakeLeader = {},
                    onRefresh = {},
                )
            }
        }
        composeRule.onNodeWithText("backend ate the request").assertIsDisplayed()
    }

    @Test fun aRefusedServerList_isLockedNotEmpty() {
        var asked = 0
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = LoadingState.Loading,
                    username = "harry",
                    pods = emptyList(),
                    leaderPodId = null,
                    onOpenPod = {},
                    onAddServer = {},
                    onMakeLeader = {},
                    onRefresh = {},
                    statusPaused = true,
                    onShowServers = { asked++ },
                )
            }
        }
        composeRule.onNodeWithText("Your server list is locked").assertIsDisplayed()
        composeRule.onNodeWithText("Add your first server").assertDoesNotExist()
        composeRule.onNodeWithText("Show my servers").performClick()
        org.junit.Assert.assertEquals(1, asked)
    }

    @Test fun orderedServers_showTheLeaderAndThePlaceInLine() {
        fun stk(n: Int) = com.flagshipserver.app.core.HexUtil.encode(
            com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { n.toByte() }).publicKey,
        )
        val pods = listOf(
            PodInfo(podId = "a", name = "home3", fqdn = "home3.harry.flagship.services",
                status = PodInfo.Status.OFFLINE, registeredAt = 1, identityPubKeyHex = stk(1)),
            PodInfo(podId = "b", name = "leticia", fqdn = "leticia.harry.flagship.services",
                status = PodInfo.Status.ONLINE, registeredAt = 2, identityPubKeyHex = stk(2)),
        )
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = LoadingState.Loading,
                    username = "harry",
                    pods = pods,
                    leaderPodId = "b",
                    onOpenPod = {},
                    onAddServer = {},
                    onMakeLeader = {},
                    onRefresh = {},
                )
            }
        }
        composeRule.onNodeWithText("Leader").assertIsDisplayed()
        composeRule.onNodeWithText("#1").assertIsDisplayed()
        composeRule.onNodeWithText("Standing in for home3 while it's down").assertIsDisplayed()
        composeRule.onNodeWithText("Touch and hold a server", substring = true).assertExists()
    }
}
