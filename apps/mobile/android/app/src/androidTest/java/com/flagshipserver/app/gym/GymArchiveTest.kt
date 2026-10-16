// GYM Android button sweep — backing a server up, importing a backup, and
// approving a backup's download in a browser. The backup runs against the
// mock box (passcode step, build, download, Save both files); the import uses
// a real sealed backup made here with a passcode (ServerBackupFormat) and the
// system picker answered by the gym, and sends it to the server that waits for
// it; the download approval comes from the browser page's link and is signed
// with the admin root (MockSignatures). NO BACKEND.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerBackupFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class GymArchiveTest : GymBase() {

    // ─── Backup/clone server ─────────────────────────────────────────────────

    /** The passcode must be saved before the backup starts; then the box
     *  builds it, both files download, and Save both files asks for a folder. */
    @Test
    fun backupWithTheSuggestedPasscode() {
        launch(tab = "home", adminRoot = true, username = "bright-maple")
        openServerFromHome("Living-room mini-PC")
        tapDesc("sd-backup-server", 20_000)
        waitUntilExists("backup-start", 15_000)
        composeRule.onNodeWithTag("backup-start").assertIsNotEnabled()
        val suggested = textOfTag("backup-suggested-passcode")
        tapText("Copy")
        eventually(what = "passcode on the clipboard") { clipboardText() == suggested }
        tap("backup-passcode-saved")
        composeRule.onNodeWithTag("backup-start").assertIsEnabled()
        gymShot("backup-passcode")
        tap("backup-start")
        eventually(what = "the box asked to build it") { screensMock.archiveStarts.size == 1 }
        tap("backup-download", 20_000)
        waitUntilExists("backup-share", 20_000)
        gymShot("backup-downloaded")
        tap("backup-share")
        eventually(what = "the folder picker") { startedIntents.any { it.action == android.content.Intent.ACTION_OPEN_DOCUMENT_TREE } }
        tapText("Done")
    }

    /** Your own passcode: typed twice, then the backup starts. */
    @Test
    fun backupWithYourOwnPasscode() {
        launch(tab = "home", adminRoot = true, username = "bright-maple")
        openServerFromHome("Living-room mini-PC")
        tapDesc("sd-backup-server", 20_000)
        tap("backup-use-own-passcode", 15_000)
        type("backup-own-passcode", "correct horse battery staple")
        type("backup-own-passcode-again", "correct horse battery staple")
        tap("backup-passcode-saved")
        tap("backup-start")
        eventually(what = "the box asked to build it") { screensMock.archiveStarts.size == 1 }
        waitUntilExists("backup-download", 20_000)
    }

    // ─── Import a backup ─────────────────────────────────────────────────────

    private class Made(val backup: File, val data: File, val archiveId: String, val bytes: Long, val sha: String)

    /** A backup made on another account: two files, sealed with [passcode]. */
    private fun makeBackup(archiveId: String, passcode: String): Made {
        val dir = File(ApplicationProvider.getApplicationContext<android.content.Context>().cacheDir, "gym-import").apply {
            deleteRecursively(); mkdirs()
        }
        val key = ByteArray(32) { 0x42 }
        val data = ServerBackupFormat.DATA_MAGIC.toByteArray() + ByteArray(2 * 1024 * 1024) { 9 }
        val sha = HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(data))
        val body = """{"createdAt":1792000000000,"server":{"name":"home","domain":"home.mina-park.flagship.services","bootUnlockMode":"approve","diskEncryption":"luks"},""" +
            """"apps":[{"serviceId":"mina-park--wiki","name":"Wiki"}],"left":[],"includes":[],"excludes":[],""" +
            """"data":{"fileName":"home-2026-10-14.flagship-data","bytes":${data.size},"sha256":"$sha","frameBytes":1048576}}"""
        val slot = ServerBackupFormat.passcodeSlot(archiveId, key, passcode, m = 64, t = 1, p = 1)
        val file = ServerBackupFormat.sealFile(archiveId, key, listOf(slot), body.toByteArray(), ByteArray(12) { 1 })
        val backup = File(dir, "home-2026-10-14.flagship-backup").apply { writeText(ServerBackupFormat.serialize(file)) }
        val dataFile = File(dir, "home-2026-10-14.flagship-data").apply { writeBytes(data) }
        return Made(backup, dataFile, archiveId, data.size.toLong(), sha)
    }

    /** Home's waiting server → Send the backup → pick both files (the system
     *  picker answered by the gym) → passcode → Send it there → restored. */
    @Test
    fun importABackupIntoTheServerWaitingForIt() {
        launch(tab = "home", adminRoot = true, username = "bright-maple", podsVariant = "awaiting-backup")
        val made = makeBackup("ab".repeat(16), "gym passcode 1234")
        pickedFiles = listOf(made.backup, made.data)
        screensMock.restoreWaiting = com.flagshipserver.app.api.ServerRestoreWaiting(made.archiveId, made.bytes, made.sha)
        waitText("Waiting for its backup", 20_000)
        composeRule.onNode(androidx.compose.ui.test.hasText("Living-room mini-PC") and androidx.compose.ui.test.hasClickAction())
            .performTouchInputCompat()
        tap("pod-card-send-backup")
        tap("import-backup-choose", 15_000)
        type("import-backup-passcode", "gym passcode 1234")
        tap("import-backup-unlock")
        tap("import-backup-send-existing", 30_000)
        waitUntilExists("import-backup-done", 30_000)
        assertEquals(com.flagshipserver.app.api.ServerRestoreStartRequest(made.archiveId, made.bytes), screensMock.restoreStarts.first())
        assertEquals(made.bytes, screensMock.restoreChunks.sumOf { it.second.toLong() })
        assertEquals(1, screensMock.restoreCommits.size)
        gymShot("restored")
        tap("import-backup-done")
    }

    /** A wrong passcode is refused before anything is sent. */
    @Test
    fun importRefusesAWrongPasscode() {
        launch(tab = "home", adminRoot = true)
        val made = makeBackup("cd".repeat(16), "the right one")
        pickedFiles = listOf(made.backup, made.data)
        tap("home-add-server", 20_000)
        tap("home-import-backup")
        tap("import-backup-choose", 15_000)
        type("import-backup-passcode", "the wrong one")
        tap("import-backup-unlock")
        composeRule.waitUntil(30_000) { tagCount("import-backup-error") > 0 || textCount("passcode", substring = true) > 1 }
        assertTrue(screensMock.restoreStarts.isEmpty())
        gymShot("wrong-passcode")
    }

    /** Picking only the backup file asks for the data file it names. */
    @Test
    fun importAsksForTheOtherFile() {
        launch(tab = "home", adminRoot = true)
        val made = makeBackup("ef".repeat(16), "x")
        pickedFiles = listOf(made.backup)
        tap("home-add-server", 20_000)
        tap("home-import-backup")
        tap("import-backup-choose", 15_000)
        eventually(what = "the files line") { textOfTag("import-backup-files").contains("home-2026-10-14.flagship-data") }
        gymShot("needs-data-file")
    }

    // ─── Approve a download in a browser ─────────────────────────────────────

    /** The browser page's link opens the approval: the code, then Approve
     *  signs with the admin root; Don't approve closes it. */
    @Test
    fun approveABackupDownloadFromTheBrowserLink() {
        val a = "12".repeat(16)
        val r = "34".repeat(16)
        launch(
            tab = "home", adminRoot = true, username = "bright-maple",
            deepLink = "flagship://backup-download#s=home.bright-maple.flagship.services&a=$a&r=$r",
        )
        waitText("Download a backup in a browser?", 20_000)
        waitUntilExistsDesc("backup-approve-code")
        gymShot("approve-download")
        tapDesc("backup-approve")
        assertSigned("backup-download", "admin")
        waitText("Approved. The downloads start in that browser.", 15_000)
        assertEquals(a, screensMock.archiveApprovals.single().approval.archiveId)
        tapText("Done")
    }

    @Test
    fun dontApproveABackupDownload() {
        launch(
            tab = "home", adminRoot = true, username = "bright-maple",
            deepLink = "flagship://backup-download#s=home.bright-maple.flagship.services&a=${"56".repeat(16)}&r=${"78".repeat(16)}",
        )
        waitText("Download a backup in a browser?", 20_000)
        tapText("Don't approve")
        waitTextGone("Download a backup in a browser?")
        assertTrue(screensMock.archiveApprovals.isEmpty())
    }
}

private fun androidx.compose.ui.test.SemanticsNodeInteraction.performTouchInputCompat() =
    performScrollTo().performTouchInput { longClick() }
