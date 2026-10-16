// Home marks a server waiting for its backup and opens the send flow from it;
// Import a backup's pages; the create screen started from a backup opens at
// its delivery chooser (docs/server-backup-and-clone.md). Mirrors iOS
// HomeScreen.backupWaits and ImportBackupScreen.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import com.flagshipserver.app.api.AwaitingBackupWire
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.ImportBackupViewModel
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.ServerBackupViewModel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ServerBackupComposeTest {
    @get:Rule val composeRule = createComposeRule()

    private val clone = PodInfo(podId = "pod-clone", name = "clone", fqdn = "clone.harry.flagship.services", status = PodInfo.Status.ONLINE)

    private fun setHome(state: String, onSend: (PodInfo) -> Unit, onOpen: (PodInfo) -> Unit) {
        composeRule.setContent {
            FlagshipTheme {
                HomeScreen(
                    state = LoadingState.Loading,
                    username = "harry",
                    pods = listOf(clone),
                    onOpenPod = onOpen,
                    onAddServer = {},
                    onMakeLeader = {},
                    onRefresh = {},
                    awaitingBackup = mapOf(clone.fqdn to AwaitingBackupWire("00112233445566778899aabbccddeeff", state)),
                    onSendBackup = onSend,
                )
            }
        }
    }

    @Test fun aWaitingServerSaysSoAndATapSendsTheBackup() {
        val sent = mutableListOf<String>()
        val opened = mutableListOf<String>()
        setHome("waiting", onSend = { sent += it.fqdn }, onOpen = { opened += it.fqdn })
        composeRule.onNodeWithText("Waiting for its backup").assertIsDisplayed()
        composeRule.onNodeWithText("clone").performClick()
        assertEquals(listOf(clone.fqdn), sent)
        composeRule.onNodeWithText("clone").performTouchInput { longClick() }
        composeRule.onNodeWithTag("pod-card-send-backup").assertIsDisplayed()
        composeRule.onNodeWithText("Open").performClick()
        assertEquals(listOf(clone.fqdn), opened)
    }

    @Test fun aRestoringServerOpensItsPage() {
        val sent = mutableListOf<String>()
        val opened = mutableListOf<String>()
        setHome("restoring", onSend = { sent += it.fqdn }, onOpen = { opened += it.fqdn })
        composeRule.onNodeWithText("Restoring its backup").assertIsDisplayed()
        composeRule.onNodeWithText("clone").performClick()
        assertEquals(listOf(clone.fqdn), opened)
        assertEquals(emptyList<String>(), sent)
    }

    @Test fun theImportScreenAsksForBothFiles() {
        val vm = ImportBackupViewModel(username = "harry", takenNames = emptySet(), clientFor = { null }, accountKek = { ByteArray(32) })
        var picks = 0
        composeRule.setContent { FlagshipTheme { ImportBackupScreen(vm = vm, pickFiles = { picks++ }) } }
        composeRule.onNodeWithText("Import a backup").assertIsDisplayed()
        composeRule.onNodeWithText("Backup file: not picked yet", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Choose the backup files").performClick()
        assertEquals(1, picks)
    }

    @Test fun theImportScreenOpenedFromAWaitingServerNamesIt() {
        val vm = ImportBackupViewModel(username = "harry", takenNames = emptySet(), targetFqdn = clone.fqdn, clientFor = { null }, accountKek = { ByteArray(32) })
        composeRule.setContent { FlagshipTheme { ImportBackupScreen(vm = vm, pickFiles = {}) } }
        composeRule.onNodeWithText("clone is waiting for its backup. Pick the backup's two files and this screen sends it.").assertIsDisplayed()
    }

    @Test fun theBackupStartsWithThePasscode() {
        val vm = ServerBackupViewModel(
            serverFqdn = clone.fqdn,
            client = MockScreensClient(simulatedLatencyMs = 0),
            accountKek = { ByteArray(32) },
            downloadDir = { java.io.File(System.getProperty("java.io.tmpdir")) },
            suggestedPasscode = "k7qm-2xhd-9twp-4frn-6cyb",
        )
        runBlocking { vm.load() }
        composeRule.setContent {
            FlagshipTheme {
                androidx.compose.foundation.layout.Column {
                    PasscodeStep(vm, copied = false, onCopy = {}, onStart = {})
                }
            }
        }
        composeRule.onNodeWithText("k7qm-2xhd-9twp-4frn-6cyb").assertIsDisplayed()
        composeRule.onNodeWithTag("backup-start").assertIsNotEnabled()
        composeRule.onNodeWithTag("backup-use-own-passcode").performClick()
        composeRule.onNodeWithText("At least 12 characters", substring = true).assertIsDisplayed()
    }

    @Test fun aCreateStartedFromABackupOpensAtTheDeliveryChooser() {
        composeRule.setContent {
            FlagshipTheme {
                CreateServerScreen(
                    onDelivered = { _, _, _, _ -> },
                    onCancel = {},
                    preset = CreateServerPreset(
                        name = "home",
                        bootUnlockMode = "approve",
                        encryptDisk = true,
                        restore = ImportBackupViewModel.RestoreTarget("00112233445566778899aabbccddeeff", 24, "ab".repeat(32)),
                    ),
                )
            }
        }
        composeRule.onNodeWithText("Get it to a builder").assertIsDisplayed()
        composeRule.onNodeWithTag("cs-delivery-share").assertIsDisplayed()
    }
}
