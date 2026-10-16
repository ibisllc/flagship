// Home's "Add/Import a server" chooser offers co-managing a server another
// account shares (docs/share-a-server.md), which opens the paste/scan screen.
// An account with no servers yet reaches it from the empty state. The
// create-server page no longer carries it.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.LoadingState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class HomeCoManageTest {
    @get:Rule val composeRule = createComposeRule()

    private fun setHome(pods: List<PodInfo>, onAdd: () -> Unit = {}, onCoManage: () -> Unit = {}) {
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = LoadingState.Loading,
                    username = "harry",
                    pods = pods,
                    onOpenPod = {},
                    onAddServer = onAdd,
                    onCoManage = onCoManage,
                    onMakeLeader = {},
                    onRefresh = {},
                )
            }
        }
    }

    private val onePod = listOf(
        PodInfo(podId = "a", name = "home", fqdn = "home.harry.flagship.services", status = PodInfo.Status.ONLINE),
    )

    @Test fun theChooserOffersCreateCoManageAndImport_withoutTheCloneHint() {
        var created = 0
        setHome(onePod, onAdd = { created++ })
        composeRule.onNodeWithTag("home-add-server").performScrollTo().performClick()
        composeRule.onNodeWithText("Co-manage a running server").assertIsDisplayed()
        composeRule.onNodeWithText("Import a backup").assertIsDisplayed()
        composeRule.onNodeWithText("Add a new server").assertDoesNotExist()
        composeRule.onNodeWithText("To clone", substring = true).assertDoesNotExist()
        composeRule.onNodeWithText("Create a new server").assertIsDisplayed().performClick()
        assertEquals(1, created)
    }

    @Test fun coManageInTheChooserOpensTheShareAcceptScreen() {
        var opened = 0
        setHome(onePod, onCoManage = { opened++ })
        composeRule.onNodeWithTag("home-add-server").performScrollTo().performClick()
        composeRule.onNodeWithTag("home-co-manage").performClick()
        assertEquals(1, opened)
    }

    @Test fun anAccountWithNoServersReachesCoManageFromTheEmptyState() {
        var opened = 0
        setHome(emptyList(), onCoManage = { opened++ })
        composeRule.onNodeWithText("Co-manage a running server").performScrollTo().assertIsDisplayed().performClick()
        assertEquals(1, opened)
    }

    @Test fun theCreateServerPageNoLongerOffersCoManage() {
        composeRule.setContent {
            FlagshipTheme {
                CreateServerScreen(onDelivered = { _, _, _, _ -> }, onCancel = {})
            }
        }
        composeRule.onNodeWithText("Co-manage", substring = true).assertDoesNotExist()
    }
}
