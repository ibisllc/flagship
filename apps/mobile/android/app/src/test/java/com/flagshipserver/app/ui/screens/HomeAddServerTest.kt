// Home's "Add/Restore server" is the one way to bring a server into the
// account: Create a new server, Co-manage a running server (docs/
// share-a-server.md) or Import a backup, with or without servers. Only an
// admin device of the account sees it (docs/service-access-gating.md
// "Account members"). The create-server page no longer carries co-manage.
// Mirrors the webapp's webappHomeAddServer.test.ts and iOS HomeAddServerTests.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performScrollTo
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.LoadingState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class HomeAddServerTest {
    @get:Rule val composeRule = createComposeRule()

    private fun setHome(
        pods: List<PodInfo>,
        canAddServers: Boolean = true,
        onAdd: () -> Unit = {},
        onCoManage: () -> Unit = {},
        onRestore: () -> Unit = {},
    ) {
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = LoadingState.Loading,
                    username = "harry",
                    pods = pods,
                    onOpenPod = {},
                    onAddServer = onAdd,
                    onRestoreBackup = onRestore,
                    onCoManage = onCoManage,
                    canAddServers = canAddServers,
                    onMakeLeader = {},
                    onRefresh = {},
                )
            }
        }
    }

    private val onePod = listOf(
        PodInfo(podId = "a", name = "home", fqdn = "home.harry.flagship.services", status = PodInfo.Status.ONLINE),
    )

    @Test fun onlyAnAdminDeviceOrADemoAccountSeesIt() {
        assertTrue(showsAddServer(holdsAdminRoot = true, isDemoAccount = false))
        assertFalse(showsAddServer(holdsAdminRoot = false, isDemoAccount = false))
        assertTrue(showsAddServer(holdsAdminRoot = false, isDemoAccount = true))
    }

    @Test fun theChooserOffersCreateCoManageAndImport_withoutTheCloneHint() {
        var created = 0
        setHome(onePod, onAdd = { created++ })
        composeRule.onNodeWithTag("home-add-server").performScrollTo().performClick()
        composeRule.onNodeWithText("Co-manage a running server").assertExists()
        composeRule.onNodeWithText("Restore from backup").assertExists()
        composeRule.onNodeWithText("Add a new server").assertDoesNotExist()
        composeRule.onNodeWithText("To clone", substring = true).assertDoesNotExist()
        composeRule.onNodeWithText("Create a server").assertExists().performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        assertEquals(1, created)
    }

    @Test fun coManageInTheChooserOpensTheShareAcceptScreen() {
        var opened = 0
        setHome(onePod, onCoManage = { opened++ })
        composeRule.onNodeWithTag("home-add-server").performScrollTo().performClick()
        composeRule.onNodeWithTag("home-co-manage").performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        assertEquals(1, opened)
    }

    @Test fun theEmptyStateOpensTheSameMenuOnAnAdminDevice() {
        var opened = 0
        setHome(emptyList(), onRestore = { opened++ })
        composeRule.onNodeWithText("Your account is ready").assertIsDisplayed()
        // No separate co-manage or create button: just Add/Restore server.
        composeRule.onNodeWithText("Co-manage a running server").assertDoesNotExist()
        composeRule.onNodeWithText("Add your first server").assertDoesNotExist()
        composeRule.onNodeWithTag("home-add-server").performScrollTo().assertIsDisplayed().performClick()
        composeRule.onNodeWithTag("home-add-new-server").assertExists()
        composeRule.onNodeWithTag("home-co-manage").assertExists()
        composeRule.onNodeWithTag("home-restore-backup").assertExists().performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        assertEquals(1, opened)
    }

    @Test fun aNonAdminDeviceGetsNoButtonOverItsServers() {
        setHome(onePod, canAddServers = false)
        composeRule.onNodeWithText("Search servers").assertExists()
        composeRule.onNodeWithTag("home-empty-state").assertDoesNotExist()
        composeRule.onNodeWithTag("home-add-server").assertDoesNotExist()
        composeRule.onNodeWithTag("home-add-new-server").assertDoesNotExist()
    }

    @Test fun aNonAdminDevicesEmptyStateSaysWhyAndHasNoButton() {
        setHome(emptyList(), canAddServers = false)
        composeRule.onNodeWithText("No servers yet").assertIsDisplayed()
        composeRule.onNodeWithText(ADD_SERVERS_ADMIN_ONLY).assertIsDisplayed()
        composeRule.onNodeWithText("Your account is ready").assertDoesNotExist()
        composeRule.onNodeWithTag("home-add-server").assertDoesNotExist()
        composeRule.onNodeWithTag("home-add-new-server").assertDoesNotExist()
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
