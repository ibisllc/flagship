// Compose UI tests for the HomeScreen — exercise each LoadingState arm
// + the empty / non-empty pods path. Runs on Robolectric so we don't
// need an emulator.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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

    private fun stk(n: Int) = com.flagshipserver.app.core.HexUtil.encode(
        com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { n.toByte() }).publicKey,
    )

    private val orderedPods = listOf(
        PodInfo(podId = "a", name = "home3", fqdn = "home3.harry.flagship.services",
            status = PodInfo.Status.OFFLINE, registeredAt = 1, identityPubKeyHex = stk(1)),
        PodInfo(podId = "b", name = "leticia", fqdn = "leticia.harry.flagship.services",
            status = PodInfo.Status.ONLINE, registeredAt = 2, identityPubKeyHex = stk(2)),
    )

    private fun setOrdered(issuedAt: Long = 0, acks: Map<String, Long> = emptyMap(), showRecoveryNudge: Boolean = false) {
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = LoadingState.Loading,
                    username = "harry",
                    pods = orderedPods,
                    serverOrderIssuedAt = issuedAt,
                    serverOrderAcks = acks,
                    onOpenPod = {},
                    onAddServer = {},
                    onMakeLeader = {},
                    onRefresh = {},
                    showRecoveryNudge = showRecoveryNudge,
                )
            }
        }
    }

    @Test fun orderedServers_showOnlyTheLeader_noPlaceInLine() {
        setOrdered()
        composeRule.onNodeWithTag("pod-leader-badge", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("Standing in for home3").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("#1").assertDoesNotExist()
        composeRule.onNodeWithText("#2").assertDoesNotExist()
        composeRule.onNodeWithText("Touch and hold a server", substring = true).assertDoesNotExist()
        composeRule.onNodeWithTag("home-server-handle-a").assertExists()
        composeRule.onNodeWithTag("home-server-handle-b").assertExists()
        composeRule.onNodeWithText("Add/Import a server").assertIsDisplayed()
    }

    @Test fun theLeaderBadge_isGrayUntilTheLeaderHoldsTheOrder() {
        setOrdered(issuedAt = 10, acks = mapOf("b" to 5L))
        composeRule.onNodeWithTag("pod-leader-badge", useUnmergedTree = true).assertDoesNotExist()
        composeRule.onNodeWithContentDescription("Leader, waiting for the server to confirm").performScrollTo().assertIsDisplayed()
    }

    @Test fun theLeaderBadge_isConfirmedOnceTheLeaderAcks() {
        setOrdered(issuedAt = 10, acks = mapOf("b" to 10L))
        composeRule.onNodeWithTag("pod-leader-badge", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithTag("pod-leader-badge-pending", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test fun theRecoveryNudge_asksForAPasskey() {
        setOrdered(showRecoveryNudge = true)
        composeRule.onNodeWithText("Set up recovery").assertIsDisplayed()
        composeRule.onNodeWithText("Save a passkey so you can recover your account if you get a new device.").assertIsDisplayed()
    }
}
