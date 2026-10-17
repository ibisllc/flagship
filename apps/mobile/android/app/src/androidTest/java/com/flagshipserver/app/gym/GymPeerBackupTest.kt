// GYM Android: peer backup v2 (docs/peer-backup.md). Settings -> Peer-backup
// shows the status (state, Server 1..n, restore-by, what the server keeps for
// others) and Add/Import a server -> Restore from other servers finds a lost
// server's backup, opens it with this account's key and has the waiting server
// fetch the pieces. Mirror of the webapp's gym-archive peer scenarios.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.PeerRootArchive
import com.flagshipserver.app.api.PeerRootSummary

import com.flagshipserver.app.core.ServerBackupFormat
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymPeerBackupTest : GymBase() {

    private val mock: MockScreensClient get() = MockScreensClient.smokeInstance!!
    private val lost = "home.smoketest.flagship.services"

    private fun waitUntilTextExists(text: String, timeoutMs: Long = 15_000) {
        composeRule.waitUntil(timeoutMs) {
            composeRule.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun count(tag: String) = composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().size

    private fun textOf(tag: String): String =
        composeRule.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().config
            .getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }.orEmpty()

    /** The lost server's record, as a running box would answer it, sealed for this account. */
    private fun record(archiveId: String): PeerRootSummary {
        val key = ByteArray(32) { 0x42 }
        val bytes = 64L * 1024
        val sha = "cd".repeat(32)
        val body = """{"createdAt":1792000000000,"server":{"name":"home","domain":"$lost","bootUnlockMode":"auto","diskEncryption":"luks"},""" +
            """"apps":[{"serviceId":"smoketest--wiki","name":"Wiki"}],"left":[],"includes":[],"excludes":[],""" +
            """"data":{"fileName":"home.flagship-data","bytes":$bytes,"sha256":"$sha","frameBytes":1048576}}"""
        val kek = runBlocking { Keystore.deriveServerArchiveKey(archiveId) }
        val slot = ServerBackupFormat.wrapAccountSlot(archiveId, key, kek, ByteArray(12))
        val file = ServerBackupFormat.sealFile(archiveId, key, listOf(slot), body.toByteArray(), ByteArray(12) { 1 })
        return PeerRootSummary(
            serverId = lost,
            archive = PeerRootArchive(archiveId, 1_792_000_000_000, bytes, sha, ServerBackupFormat.serialize(file)),
            holders = 3,
            needed = 2,
            keepUntil = System.currentTimeMillis() + 40L * 24 * 3_600_000,
        )
    }

    private fun openRestoreFromPeers(vararg launchArgs: Pair<String, String>, podsVariant: String? = null, backups: String? = null) {
        launch(tab = "home", adminRoot = true, podsVariant = podsVariant, backups = backups)
        composeRule.onNodeWithTag("home-add-server").performScrollTo().performClick()
        waitUntilExists("home-restore-peers")
        composeRule.onNodeWithTag("home-restore-peers").performClick()
        waitUntilExists("restore-peers-lost", timeoutMs = 15_000)
    }

    @Test
    fun theStatusPageNamesServersNotOwners() {
        launch(tab = "settings")
        waitUntilTextExists("Peer-backup")
        composeRule.onNodeWithText("Peer-backup").performScrollTo().performClick()
        waitUntilExists("peer-backup-state-protected", timeoutMs = 20_000)
        assertEquals("Protected", textOf("peer-backup-state-title"))
        assertEquals("three holders, never named", 3, count("peer-backup-holder"))
        composeRule.onNodeWithText("Server 1").assertIsDisplayed()
        assertTrue("the restore-by date", textOf("peer-backup-restore-by").startsWith("Restore by "))
        composeRule.onNodeWithTag("peer-backup-hosting").performScrollTo().assertIsDisplayed()
        gymShot("peer-backup-status")
    }

    @Test
    fun restoreFromOtherServersFindsAndOpensTheRecord() {
        openRestoreFromPeers()
        mock.peerRootFixture = record("00112233445566778899aabbccddeeff")
        composeRule.onNodeWithTag("restore-peers-lost").performTextInput(lost)
        composeRule.onNodeWithTag("restore-peers-find").performClick()
        // Opening the record runs the account-key crypto: wait for the name step or the refusal, and name the refusal.
        composeRule.waitUntil(40_000) {
            composeRule.onAllNodesWithTag("import-backup-name").fetchSemanticsNodes().isNotEmpty() ||
                composeRule.onAllNodesWithTag("import-backup-error").fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue("the record opened: " + (if (count("import-backup-error") > 0) textOf("import-backup-error") else ""), count("import-backup-name") > 0)
        waitUntilTextExists("Backup of $lost")
        waitUntilTextExists("3 servers hold its pieces; 2 bring it back.")
        assertEquals("the server was asked with the PBK, not the key", 1, mock.peerRootRequests.size)
        assertEquals(64, mock.peerRootRequests.single().pbkHex.length)
        gymShot("restore-peers-found")
    }

    @Test
    fun aMissingRecordSaysSo() {
        openRestoreFromPeers()
        mock.peerRootFixture = null
        composeRule.onNodeWithTag("restore-peers-lost").performTextInput(lost)
        composeRule.onNodeWithTag("restore-peers-find").performClick()
        waitUntilExists("import-backup-error", timeoutMs = 20_000)
        gymShot("restore-peers-not-found")
    }

    @Test
    fun aWaitingServerFetchesThePiecesAndRestores() {
        openRestoreFromPeers(podsVariant = "awaiting-backup", backups = "restore-partial")
        mock.peerRootFixture = record("ab".repeat(16))
        composeRule.onNodeWithTag("restore-peers-lost").performTextInput(lost)
        composeRule.onNodeWithTag("restore-peers-find").performClick()
        waitUntilExists("import-backup-send-existing", timeoutMs = 20_000)
        composeRule.onNodeWithTag("import-backup-send-existing").performClick()
        waitUntilExists("import-backup-restored", timeoutMs = 30_000)
        assertEquals("Restored 1 app", textOf("import-backup-restored"))
        assertEquals("the server fetched the pieces, nothing was uploaded", 1, mock.peerFetches.size)
        assertTrue(mock.restoreChunks.isEmpty())
        assertEquals(1, mock.restoreCommits.size)
        gymShot("restore-peers-done")
    }
}
