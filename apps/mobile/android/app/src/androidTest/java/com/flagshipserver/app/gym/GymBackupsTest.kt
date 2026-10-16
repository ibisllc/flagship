// GYM Android mock tier — saved backups, the backup policy and the one-file
// backup (docs/server-backup-and-clone.md), twins of iOS GymBackupsTests and
// the webapp's backups scenarios: keys deposited by an admin, a non-admin
// waiting, Back up now into the list, a failed run, the schedule in local
// time, download and delete, the wizard's policy step, the server page's
// policy, importing one .flagship file (and refusing a damaged one), and a
// restore where one app fails. NO BACKEND: the mock box answers the routes
// like the real one; the gym reads what reached it through
// MockScreensClient.smokeInstance.

package com.flagshipserver.app.gym

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ServerBackupKdf
import com.flagshipserver.app.core.AdminOrderGate
import com.flagshipserver.app.core.BackupsText
import com.flagshipserver.app.core.GymSeams
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerBackupFormat
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class GymBackupsTest : GymBase() {

    private val mock: MockScreensClient get() = MockScreensClient.smokeInstance!!

    @After fun clearSeams() {
        GymSeams.importBackupFile = null
    }

    private fun waitUntilTextExists(text: String, timeoutMs: Long = 10_000) {
        composeRule.waitUntil(timeoutMs) {
            composeRule.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun textOf(tag: String): String =
        composeRule.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().config
            .getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }.orEmpty()

    private fun exists(tag: String) = composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    /** Home → the Home server's page → its Backups section, loaded. */
    private fun openBackups(adminRoot: Boolean, backups: String? = null, before: (MockScreensClient) -> Unit = {}) {
        launch(tab = "home", adminRoot = adminRoot, backups = backups)
        before(mock)
        waitUntilTextExists("Living-room mini-PC", timeoutMs = 20_000)
        composeRule.onNodeWithText("Living-room mini-PC").performScrollTo().performClick()
        waitUntilExists("sd-backups-status", timeoutMs = 20_000)
        composeRule.onNodeWithTag("sd-backups-status").performScrollTo()
    }

    // 1. No backups yet, an admin device: one approval hands the box its keys.
    @Test
    fun anAdminDeviceApprovesTheKeysOnce() {
        openBackups(adminRoot = true, backups = "empty")
        assertEquals(BackupsText.NO_BACKUPS, textOf("sd-backups-status"))
        if (exists("sd-backups-approve")) {
            gymShot("backups-approve")
            composeRule.onNodeWithTag("sd-backups-approve").performScrollTo().performClick()
        }
        waitUntilExists("sd-backups-next", timeoutMs = 20_000)
        assertTrue(textOf("sd-backups-next").startsWith("Next backup: "))
        assertEquals("one approval, one batch", 1, mock.backupKeyDeposits.size)
        assertEquals(400, mock.backupKeyDeposits.single().keys.size)
        gymShot("backups-keys-deposited")
    }

    // 2. A non-admin device with no keys on the box: the box's reason, and the orders disabled.
    @Test
    fun aNonAdminDeviceSeesTheBoxsReason() {
        openBackups(adminRoot = false) { it.backupKeyPool.clear() }
        waitUntilExists("sd-backups-waiting", timeoutMs = 15_000)
        assertTrue(textOf("sd-backups-waiting").startsWith("an admin device of your account hasn't approved backups for this server yet"))
        composeRule.onNodeWithTag("sd-backups-run").assertIsNotEnabled()
        composeRule.onNodeWithTag("sd-backups-schedule-change").assertIsNotEnabled()
        composeRule.onNodeWithTag("sd-backups-policy-change").assertIsNotEnabled()
        composeRule.onAllNodesWithTag("sd-backups-delete-%032x".format(9000))[0].assertIsNotEnabled()
        assertEquals(AdminOrderGate.SERVER, textOf("sd-backups-admin-only"))
        assertTrue(mock.backupKeyDeposits.isEmpty())
        gymShot("backups-non-admin")
    }

    // 3. Back up now: progress, then the new backup heads the list.
    @Test
    fun backUpNowShowsProgressThenLists() {
        openBackups(adminRoot = true)
        val before = mock.savedBackupsList.size
        composeRule.onNodeWithTag("sd-backups-run").performScrollTo().performClick()
        waitUntilTextExists("Backing up…", timeoutMs = 15_000)
        gymShot("backups-running")
        composeRule.waitUntil(20_000) { mock.savedBackupsList.size == before + 1 && textOf("sd-backups-status").startsWith("Last backup: ") }
        val id = mock.savedBackupsList.first().archiveId
        waitUntilExists("sd-backups-row-$id")
        assertTrue(composeRule.onAllNodesWithText("Back up now · 2 apps", substring = true).fetchSemanticsNodes().isNotEmpty())
        gymShot("backups-listed")
    }

    // 4. The last run failed: the red line in the box's words.
    @Test
    fun aFailedRunSaysWhyInTheBoxsWords() {
        openBackups(adminRoot = true, backups = "failed")
        waitUntilExists("sd-backups-failed")
        assertEquals("The last backup failed: needs about 12.0 GB, has 3.1 GB.", textOf("sd-backups-failed"))
        gymShot("backups-failed")
    }

    // 5. Weekly at a local time: the PUT carries the UTC minute and weekday.
    @Test
    fun weeklyAtALocalTimeIsSentInUtc() {
        openBackups(adminRoot = true)
        val start = BackupsText.toLocal(mock.backupSchedule)
        composeRule.onNodeWithTag("sd-backups-schedule-change").performScrollTo().performClick()
        waitUntilExists("sd-backups-freq-weekly")
        composeRule.onNodeWithTag("sd-backups-freq-weekly").performClick()
        composeRule.onNodeWithTag("sd-backups-weekday-next").performClick()
        composeRule.onNodeWithTag("sd-backups-hour-up").performClick()
        composeRule.onNodeWithTag("sd-backups-minute-up").performClick()
        gymShot("backups-schedule-editor")
        composeRule.onNodeWithTag("sd-backups-schedule-save").performClick()
        composeRule.waitUntil(15_000) { mock.backupSchedulePuts.isNotEmpty() }
        val want = BackupsText.toUtc("weekly", BackupsText.LocalSlot((start.weekday + 1) % 7, (start.minuteOfDay + 75) % 1440), 7, 4)
        assertEquals(want, mock.backupSchedulePuts.single())
        waitUntilTextExists("Weekly on ")
        gymShot("backups-schedule-weekly")
    }

    // 6. Download a saved backup (its one file) and delete another.
    @Test
    fun downloadOneFileAndDeleteOne() {
        openBackups(adminRoot = true)
        val newest = mock.savedBackupsList.first()
        val oldest = mock.savedBackupsList.last()
        composeRule.onNodeWithTag("sd-backups-download-${newest.archiveId}").performScrollTo().performClick()
        waitUntilExists("sd-backups-downloaded-${newest.archiveId}", timeoutMs = 20_000)
        assertEquals("Downloaded ${newest.bundleFileName}.", textOf("sd-backups-downloaded-${newest.archiveId}"))
        assertTrue(newest.bundleFileName.endsWith(".flagship"))
        assertTrue(exists("sd-backups-save-${newest.archiveId}"))
        assertTrue("the box keeps saved backups", mock.savedBackupsList.any { it.archiveId == newest.archiveId })
        gymShot("backups-downloaded")
        composeRule.onNodeWithTag("sd-backups-delete-${oldest.archiveId}").performScrollTo().performClick()
        waitUntilTextExists(BackupsText.DELETE_CONFIRM)
        gymShot("backups-delete-confirm")
        composeRule.onNodeWithTag("sd-backups-delete-confirm").performClick()
        composeRule.waitUntil(15_000) { !exists("sd-backups-row-${oldest.archiveId}") }
        assertEquals(listOf(oldest.archiveId), mock.backupDeletes)
    }

    // 7. The create wizard's backup step: the three policies in the shared
    // words, and the phone's reserve (the signed sibling is pinned in
    // CreateServerBackupPolicyTest: the gym never reaches the box's deposit).
    @Test
    fun theWizardOffersTheThreePoliciesWithAReserve() {
        launch(tab = "home", adminRoot = true)
        addNewServer()
        nameServerAndNext()
        waitUntilExists("cs-next-button")
        composeRule.onNodeWithTag("cs-next-button").performScrollTo().performClick()
        waitUntilExists("cs-backup-policy-phone", timeoutMs = 15_000)
        waitUntilTextExists(BackupsText.PHONE_BODY)
        waitUntilTextExists(BackupsText.PEER_BODY)
        waitUntilTextExists(BackupsText.NONE_BODY)
        assertTrue(textOf("cs-backup-policy-reserve").endsWith(" GB"))
        waitUntilTextExists("This phone has ")
        gymShot("wizard-backup-policy")
        composeRule.onNodeWithTag("cs-backup-policy-peer").performScrollTo().performClick()
        composeRule.waitUntil(5_000) { !exists("cs-backup-policy-reserve") }
        gymShot("wizard-backup-policy-peer")
    }

    // 8. The server page's policy: Phone → Peer (signed), a refusal in the
    // box's words, over the limit in red, the peer status, and Not chosen yet.
    @Test
    fun thePolicyChangesAndRefusalsAreTheBoxs() {
        openBackups(adminRoot = true)
        assertEquals("Backup policy: Phone-side backups · up to 32 GB", textOf("sd-backups-policy"))
        assertEquals("Apps use 3.2 GB of 32 GB", textOf("sd-backups-usage"))
        composeRule.onNodeWithTag("sd-backups-policy-change").performScrollTo().performClick()
        waitUntilExists("sd-backups-policy-peer")
        composeRule.onNodeWithTag("sd-backups-policy-peer").performClick()
        composeRule.onNodeWithTag("sd-backups-policy-save").performClick()
        composeRule.waitUntil(15_000) { textOf("sd-backups-policy") == "Backup policy: Peer-distributed backups" }
        assertEquals("peer", mock.backupPolicyPosts.single().order.policy)
        waitUntilExists("sd-backups-peer")
        assertTrue(composeRule.onAllNodesWithText("12 of 12 pieces safe").fetchSemanticsNodes().isNotEmpty())
        gymShot("backups-policy-peer")

        // Back to the phone with a reserve smaller than the apps' data: refused.
        composeRule.onNodeWithTag("sd-backups-policy-change").performScrollTo().performClick()
        waitUntilExists("sd-backups-policy-phone")
        composeRule.onNodeWithTag("sd-backups-policy-phone").performClick()
        waitUntilExists("sd-backups-policy-reserve-down")
        while (composeRule.onAllNodes(hasTestTag("sd-backups-policy-reserve-down") and isEnabled()).fetchSemanticsNodes().isNotEmpty()) {
            composeRule.onNodeWithTag("sd-backups-policy-reserve-down").performClick()
        }
        composeRule.onNodeWithTag("sd-backups-policy-save").performClick()
        waitUntilExists("sd-backups-policy-error", timeoutMs = 15_000)
        assertEquals(
            "This server holds 3.2 GB of app data, more than the 1.0 GB your device would keep. Reserve at least 3.2 GB on that device, or remove apps or data first.",
            textOf("sd-backups-policy-error"),
        )
        gymShot("backups-policy-refused")
    }

    @Test
    fun overTheLimitShowsTheBoxsReasonInRed() {
        openBackups(adminRoot = true, backups = "over")
        waitUntilExists("sd-backups-over")
        assertTrue(textOf("sd-backups-over").startsWith("This server holds 40 GB of app data, over its backup limit of 32 GB"))
        gymShot("backups-over-limit")
    }

    @Test
    fun anUnchosenPolicyAsksToChoose() {
        openBackups(adminRoot = true, backups = "unset")
        assertEquals("Backup policy: Not chosen yet", textOf("sd-backups-policy"))
        composeRule.onNodeWithText("Choose").assertExists()
        composeRule.onNodeWithTag("sd-backups-policy-change").performClick()
        waitUntilExists("sd-backups-policy-peer")
        composeRule.onNodeWithTag("sd-backups-policy-peer").performClick()
        composeRule.onNodeWithTag("sd-backups-policy-save").performClick()
        composeRule.waitUntil(15_000) { textOf("sd-backups-policy") == "Backup policy: Peer-distributed backups" }
        gymShot("backups-policy-chosen")
    }

    // ── One .flagship file ─────────────────────────────────────────

    private val passcode = "correct horse battery staple"

    /** A small backup made on another account (passcode only), as one file. */
    private fun bundleFile(name: String, archiveId: String = "00112233445566778899aabbccddeeff", cutAt: Int? = null): File {
        val key = ByteArray(32) { 0x42 }
        val data = ServerBackupFormat.DATA_MAGIC.toByteArray() + ByteArray(64 * 1024) { 9 }
        val sha = HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(data))
        val body = """{"createdAt":1792000000000,"server":{"name":"cabin","domain":"cabin.other.flagship.services","bootUnlockMode":"auto","diskEncryption":"luks"},""" +
            """"apps":[{"serviceId":"other--wiki","name":"Wiki"},{"serviceId":"other--notes","name":"Notes"}],"left":[],"includes":[],"excludes":[],""" +
            """"data":{"fileName":"cabin.flagship-data","bytes":${data.size},"sha256":"$sha","frameBytes":1048576}}"""
        val kdf = ServerBackupKdf(m = 64, t = 1, p = 1, saltHex = "00".repeat(16))
        val slot = ServerBackupFormat.wrapPasscodeSlot(archiveId, key, ServerBackupFormat.passcodeKek(passcode, kdf), kdf, ByteArray(12))
        val meta = ServerBackupFormat.serialize(ServerBackupFormat.sealFile(archiveId, key, listOf(slot), body.toByteArray(), ByteArray(12) { 1 })).toByteArray()
        val whole = ServerBackupFormat.bundleHeader(meta.size) + meta + data
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "gym-import").apply { mkdirs() }
        return File(dir, name).apply { writeBytes(if (cutAt != null) whole.copyOf(cutAt) else whole) }
    }

    private fun typePasscodeAndOpen() {
        waitUntilExists("import-backup-passcode", timeoutMs = 15_000)
        composeRule.onNode(hasSetTextAction() and hasAnyAncestor(hasTestTag("import-backup-passcode"))).performTextInput(passcode)
        composeRule.onNodeWithTag("import-backup-unlock").performClick()
    }

    private fun openImport() {
        launch(tab = "home", adminRoot = true)
        composeRule.onNodeWithTag("home-add-server").performScrollTo().performClick()
        waitUntilExists("home-import-backup")
        composeRule.onNodeWithTag("home-import-backup").performClick()
        waitUntilExists("import-backup-choose", timeoutMs = 15_000)
    }

    @Test
    fun importOneFile() {
        GymSeams.importBackupFile = bundleFile("cabin-2026-10-16-0300.flagship")
        openImport()
        composeRule.onNodeWithTag("import-backup-choose").performClick()
        typePasscodeAndOpen()
        waitUntilExists("import-backup-name", timeoutMs = 20_000)
        waitUntilTextExists("From cabin.other.flagship.services")
        gymShot("import-one-file")
    }

    @Test
    fun aDamagedFileIsRefusedWithASentence() {
        GymSeams.importBackupFile = bundleFile("cut.flagship", cutAt = 40)
        openImport()
        composeRule.onNodeWithTag("import-backup-choose").performClick()
        waitUntilExists("import-backup-error")
        assertEquals("This backup is cut short: it ends before its data.", textOf("import-backup-error"))
        gymShot("import-damaged")
        GymSeams.importBackupFile = File(bundleFile("junk.flagship").parentFile, "junk.txt").apply { writeText("not a backup at all, just some text\n") }
        composeRule.onNodeWithTag("import-backup-choose").performClick()
        composeRule.waitUntil(10_000) { textOf("import-backup-error") == "This file isn't a Flagship backup." }
    }

    // B. A restore that gives up on one app: the result names it, Home shows a normal server.
    @Test
    fun aRestoreWithAFailedAppEndsAndNamesIt() {
        GymSeams.importBackupFile = bundleFile("waiting.flagship", archiveId = "ab".repeat(16))
        launch(tab = "home", podsVariant = "awaiting-backup", backups = "restore-partial", adminRoot = true)
        waitUntilExists("pod-card-send-backup", timeoutMs = 20_000)
        composeRule.onAllNodesWithTag("pod-card-send-backup")[0].performScrollTo().performClick()
        waitUntilExists("import-backup-choose", timeoutMs = 15_000)
        composeRule.onNodeWithTag("import-backup-choose").performClick()
        typePasscodeAndOpen()
        waitUntilExists("import-backup-send-existing", timeoutMs = 20_000)
        composeRule.onNodeWithTag("import-backup-send-existing").performClick()
        waitUntilExists("import-backup-restored", timeoutMs = 30_000)
        assertEquals("Restored 1 app", textOf("import-backup-restored"))
        assertEquals("Couldn't restore: Notes: its image didn't build", textOf("import-backup-failed-app"))
        gymShot("restore-partial")
        composeRule.onNodeWithTag("import-backup-done").performClick()
        composeRule.waitUntil(10_000) { composeRule.onAllNodesWithText("Waiting for its backup").fetchSemanticsNodes().isEmpty() }
    }
}
