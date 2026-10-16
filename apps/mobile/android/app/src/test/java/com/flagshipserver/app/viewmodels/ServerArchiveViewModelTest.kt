// The server page's backup flow and Home's Import a backup flow against the
// mock box. Mirrors the iOS ServerArchiveViewModelTests.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ServerArchiveStartRequest
import com.flagshipserver.app.api.ServerBackupKdf
import com.flagshipserver.app.api.ServerBackupSlot
import com.flagshipserver.app.api.ServerRestoreCommitRequest
import com.flagshipserver.app.api.ServerRestoreStartRequest
import com.flagshipserver.app.api.ServerRestoreWaiting
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerArchive
import com.flagshipserver.app.core.ServerBackupFormat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

class ServerArchiveViewModelTest {
    private val dirs = mutableListOf<File>()
    private val scopes = mutableListOf<CoroutineScope>()

    @After fun cleanUp() {
        scopes.forEach { it.cancel() }
        dirs.forEach { it.deleteRecursively() }
    }

    private fun tmp(): File = Files.createTempDirectory("archive-vm").toFile().also { dirs += it }

    private fun client() = MockScreensClient(simulatedLatencyMs = 0)

    private val accountKek = ByteArray(32) { 0xab.toByte() }
    private val fakePasscodeSlot: suspend (String, ByteArray, String) -> ServerBackupSlot = { id, key, _ ->
        ServerBackupFormat.wrapPasscodeSlot(
            id, key, ByteArray(32) { 0x11 },
            ServerBackupKdf(m = 64, t = 1, p = 1, saltHex = "00".repeat(16)), ByteArray(12),
        )
    }

    private fun backupVM(c: MockScreensClient, fqdn: String = "home.alice.flagship.services", suggested: String = "k7qm-2xhd-9twp-4frn-6cyb"): ServerBackupViewModel {
        val dir = tmp()
        return ServerBackupViewModel(
            serverFqdn = fqdn,
            client = c,
            accountKek = { accountKek },
            downloadDir = { dir },
            passcodeSlot = fakePasscodeSlot,
            suggestedPasscode = suggested,
            pollMs = 1,
        )
    }

    // ── Backup ─────────────────────────────────────────────────────

    @Test fun backupAsksForThePasscodeThenSendsBothSlots() = runBlocking {
        val c = client()
        val vm = backupVM(c, fqdn = "Home.alice.flagship.services")
        vm.load()
        assertEquals(ServerBackupViewModel.Phase.Passcode, vm.phase.value)
        assertFalse("not until the passcode is saved", vm.canStart)
        vm.useOwnPasscode = true
        vm.ownPasscode = "short"
        assertNotNull(vm.ownPasscodeHint)
        assertNull(vm.chosenPasscode)
        vm.ownPasscode = "Tr0ub4dor&3x"
        vm.ownPasscodeAgain = "Tr0ub4dor&3y"
        assertEquals("The two don't match.", vm.ownPasscodeHint)
        vm.useOwnPasscode = false
        vm.passcodeSaved = true
        assertTrue(vm.canStart)
        vm.start()
        val ready = vm.phase.value as? ServerBackupViewModel.Phase.Ready ?: return@runBlocking fail("expected ready, got ${vm.phase.value}")
        assertEquals(5_000L, ready.bytes)
        val start = c.archiveStarts.first()
        assertTrue(ServerArchive.isArchiveId(start.archiveId))
        assertEquals(listOf("passcode", "account"), start.slots.map { it.kind })
        // The account slot opens with this account's key to the content key the box got.
        val key = HexUtil.decode(start.key)!!
        assertArrayEquals(key, ServerBackupFormat.unwrap(start.archiveId, start.slots[1], accountKek))
        assertFalse(
            "the passcode never leaves the phone",
            Json.encodeToString(ServerArchiveStartRequest.serializer(), start).contains("k7qm"),
        )

        vm.download()
        val saved = vm.phase.value as? ServerBackupViewModel.Phase.Saved ?: return@runBlocking fail("expected saved, got ${vm.phase.value}")
        assertEquals(listOf("flagship-backup", "flagship-data"), saved.files.map { it.extension })
        assertArrayEquals(c.archiveBackupFile, saved.files[0].readBytes())
        assertArrayEquals(c.archiveBytes, saved.files[1].readBytes())
        assertTrue("the server drops its copy once the files are safe here", c.archiveForgotten)
    }

    @Test fun backupDownloadIsPartsAtOnceAndChecked() = runBlocking {
        val c = client()
        c.archiveBytes = ByteArray(9 * 1024 * 1024) { (it and 0xff).toByte() }
        val vm = backupVM(c)
        vm.load()
        vm.passcodeSaved = true
        vm.start()
        vm.download()
        val saved = vm.phase.value as? ServerBackupViewModel.Phase.Saved ?: return@runBlocking fail("expected saved, got ${vm.phase.value}")
        assertArrayEquals(c.archiveBytes, saved.files[1].readBytes())
    }

    @Test fun aBackupAlreadyMadeIsFollowed() = runBlocking {
        val c = client()
        c.archiveStarts += ServerArchiveStartRequest("00112233445566778899aabbccddeeff", "00".repeat(32), emptyList())
        val vm = backupVM(c)
        vm.load()
        assertEquals(ServerBackupViewModel.Phase.Ready(5_000), vm.phase.value)
    }

    @Test fun backupFailureIsShownNotThrown() = runBlocking {
        val c = client()
        val vm = backupVM(c)
        vm.load()
        vm.passcodeSaved = true
        c.shouldFail = true
        vm.start()
        assertTrue("expected failed, got ${vm.phase.value}", vm.phase.value is ServerBackupViewModel.Phase.Failed)
    }

    // ── Restore ────────────────────────────────────────────────────

    private class Backup(
        val backupFile: File,
        val dataFile: File,
        val archiveId: String,
        val contentKey: ByteArray,
        val dataBytes: Long,
        val sha256: String,
    )

    private fun makeBackup(name: String = "home", corruptData: Boolean = false): Backup {
        val dir = tmp()
        val id = "00112233445566778899aabbccddeeff"
        val key = ByteArray(32) { 0x42 }
        val data = ServerBackupFormat.DATA_MAGIC.toByteArray() + ByteArray(9 * 1024 * 1024) { 9 }
        val sha = HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(data))
        val body = """{"createdAt":1792000000000,"server":{"name":"$name","domain":"$name.alice.flagship.services","bootUnlockMode":"approve","diskEncryption":"luks"},""" +
            """"apps":[{"serviceId":"alice--wiki","name":"Wiki"}],"left":[],"includes":[],"excludes":[],""" +
            """"data":{"fileName":"$name-2026-10-14.flagship-data","bytes":${data.size},"sha256":"$sha","frameBytes":1048576}}"""
        val account = ServerBackupFormat.wrapAccountSlot(id, key, accountKek, ByteArray(12))
        val file = ServerBackupFormat.sealFile(id, key, listOf(account), body.toByteArray(), ByteArray(12) { 1 })
        val backupFile = File(dir, "$name-2026-10-14.flagship-backup").apply { writeText(ServerBackupFormat.serialize(file)) }
        if (corruptData) data[data.size - 1] = (data[data.size - 1].toInt() xor 1).toByte()
        val dataFile = File(dir, "$name-2026-10-14.flagship-data").apply { writeBytes(data) }
        return Backup(backupFile, dataFile, id, key, data.size.toLong(), sha)
    }

    private fun importVM(
        c: MockScreensClient,
        taken: Set<String> = emptySet(),
        waiting: Map<String, String> = emptyMap(),
        kek: ByteArray = accountKek,
        onRestored: (String) -> Unit = {},
    ): ImportBackupViewModel {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return ImportBackupViewModel(
            username = "alice",
            takenNames = taken,
            waitingServers = waiting,
            clientFor = { c },
            accountKek = { kek },
            openWithPasscode = { _, _ -> throw ServerBackupFormat.FormatException(ServerBackupFormat.FormatException.Kind.WRONG_PASSCODE) },
            onRestored = onRestored,
            pollMs = 1,
            scope = scope,
        )
    }

    private suspend fun waitFor(timeoutMs: Long = 10_000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (!cond()) {
            if (System.currentTimeMillis() > end) fail("timed out")
            delay(2)
        }
    }

    @Test fun picksOpensChecksNamesCreatesAndSends() = runBlocking {
        val b = makeBackup()
        val c = client()
        val restored = mutableListOf<String>()
        val vm = importVM(c, onRestored = { restored += it })
        vm.choose(listOf(LocalPickedFile(b.backupFile)))
        assertEquals("the data file is still missing", ImportBackupViewModel.Phase.Pick, vm.phase.value)
        assertTrue("it names the file it still needs", vm.filesSummary.contains("home-2026-10-14.flagship-data"))
        vm.choose(listOf(LocalPickedFile(b.dataFile)))
        assertEquals(ImportBackupViewModel.Phase.Name, vm.phase.value)
        assertEquals("the saved name, since the account has no server called that", "home", vm.name)
        assertEquals("Copied from the backup: asks your phone at every start, disk encrypted.", vm.settingsLine)
        assertTrue(vm.previewFqdn, vm.previewFqdn.startsWith("home.alice."))
        assertTrue(vm.canCreate)
        vm.create()
        assertEquals(ImportBackupViewModel.Phase.Creating, vm.phase.value)
        assertEquals(
            ImportBackupViewModel.CreateTarget(
                name = "home",
                bootUnlockMode = "approve",
                diskEncryption = "luks",
                restore = ImportBackupViewModel.RestoreTarget(b.archiveId, b.dataBytes, b.sha256),
            ),
            vm.createTarget,
        )

        // The new server comes up waiting for exactly this backup.
        c.restoreWaiting = ServerRestoreWaiting(b.archiveId, b.dataBytes, b.sha256)
        vm.send("home.alice.flagship.services")
        assertEquals("the create screen stays up while the send starts", ImportBackupViewModel.Phase.Creating, vm.phase.value)
        vm.leaveCreate("home.alice.flagship.services")
        waitFor { vm.phase.value is ImportBackupViewModel.Phase.Done }
        assertEquals(ServerRestoreStartRequest(b.archiveId, b.dataBytes), c.restoreStarts.first())
        assertEquals(listOf(0L, 4L * 1024 * 1024, 8L * 1024 * 1024), c.restoreChunks.map { it.first })
        assertEquals(b.dataBytes, c.restoreChunks.sumOf { it.second.toLong() })
        assertEquals(listOf(ServerRestoreCommitRequest(HexUtil.encode(b.contentKey))), c.restoreCommits)
        assertEquals(listOf("home.alice.flagship.services"), restored)
    }

    @Test fun aNameTheAccountUsesIsNotSuggestedAndIsRefused() = runBlocking {
        val b = makeBackup()
        val vm = importVM(client(), taken = setOf("home"))
        vm.choose(listOf(LocalPickedFile(b.backupFile), LocalPickedFile(b.dataFile)))
        assertEquals(ImportBackupViewModel.Phase.Name, vm.phase.value)
        assertEquals("", vm.name)
        assertEquals("You already have a server called \"home\": pick another name.", vm.nameProblem)
        vm.name = "home"
        assertFalse(vm.canCreate)
        assertEquals("You already have a server called \"home\".", vm.nameProblem)
        vm.name = "home2"
        assertNull(vm.nameProblem)
        assertTrue(vm.canCreate)
        vm.name = "-bad"
        assertNotNull(vm.nameProblem)
    }

    @Test fun anotherAccountsBackupAsksForThePasscode() = runBlocking {
        val b = makeBackup()
        val vm = importVM(client(), kek = ByteArray(32))
        vm.choose(listOf(LocalPickedFile(b.backupFile), LocalPickedFile(b.dataFile)))
        assertEquals(ImportBackupViewModel.Phase.Passcode, vm.phase.value)
        vm.passcode = "wrong one"
        vm.unlock()
        assertEquals(ImportBackupViewModel.Phase.Passcode, vm.phase.value)
        assertEquals("That passcode doesn't open this backup.", vm.fileError)
    }

    @Test fun theRealPasscodeOpensABackupOfAnotherAccount() = runBlocking {
        val b = makeBackup()
        val raw = ServerBackupFormat.parse(b.backupFile.readBytes())
        val pass = ServerBackupFormat.passcodeSlot(raw.archiveId, b.contentKey, "correct horse battery staple", m = 64, t = 1, p = 1)
        b.backupFile.writeText(ServerBackupFormat.serialize(raw.copy(slots = listOf(pass) + raw.slots)))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val vm = ImportBackupViewModel(
            username = "alice", takenNames = emptySet(), clientFor = { client() },
            accountKek = { ByteArray(32) }, pollMs = 1, scope = scope,
        )
        vm.choose(listOf(LocalPickedFile(b.backupFile), LocalPickedFile(b.dataFile)))
        assertEquals(ImportBackupViewModel.Phase.Passcode, vm.phase.value)
        vm.passcode = "  correct horse battery staple "
        vm.unlock()
        assertEquals(ImportBackupViewModel.Phase.Name, vm.phase.value)
        assertEquals("passcode", vm.opened?.via)
        assertEquals("", vm.passcode)
    }

    @Test fun aChangedDataFileIsRefusedBeforeAnythingIsMade() = runBlocking {
        val b = makeBackup(corruptData = true)
        val vm = importVM(client())
        vm.choose(listOf(LocalPickedFile(b.backupFile), LocalPickedFile(b.dataFile)))
        assertEquals(ImportBackupViewModel.Phase.Pick, vm.phase.value)
        assertEquals("The data file doesn't match the backup file: it was changed or is damaged.", vm.fileError)
        assertNull("it asks for the data file again", vm.dataFileName)
    }

    @Test fun aServerWaitingForThisBackupIsOffered() = runBlocking {
        val b = makeBackup()
        val vm = importVM(client(), waiting = mapOf(b.archiveId to "clone.alice.flagship.services"))
        vm.choose(listOf(LocalPickedFile(b.backupFile), LocalPickedFile(b.dataFile)))
        assertEquals(ImportBackupViewModel.Phase.ChooseTarget("clone.alice.flagship.services"), vm.phase.value)
        vm.showName()
        assertEquals(ImportBackupViewModel.Phase.Name, vm.phase.value)
    }

    @Test fun anUploadResumesWhereTheServerGotTo() = runBlocking {
        val b = makeBackup()
        val c = client()
        c.restoreWaiting = ServerRestoreWaiting(b.archiveId, b.dataBytes, b.sha256)
        c.restoreAlreadyReceived = 4L * 1024 * 1024
        val vm = importVM(c, waiting = mapOf(b.archiveId to "clone.alice.flagship.services"))
        vm.choose(listOf(LocalPickedFile(b.backupFile), LocalPickedFile(b.dataFile)))
        vm.send("clone.alice.flagship.services")
        waitFor { vm.phase.value is ImportBackupViewModel.Phase.Done }
        assertEquals(listOf(4L * 1024 * 1024, 8L * 1024 * 1024), c.restoreChunks.map { it.first })
    }

    @Test fun aChunkThatFailsAsksTheServerWhereItGotTo() = runBlocking {
        val b = makeBackup()
        var failNext = true
        val mock = client()
        mock.restoreWaiting = ServerRestoreWaiting(b.archiveId, b.dataBytes, b.sha256)
        val c = object : com.flagshipserver.app.api.ScreensClient by mock {
            override suspend fun serverRestoreChunk(offset: Long, data: ByteArray) {
                if (offset == 4L * 1024 * 1024 && failNext) {
                    failNext = false
                    throw java.io.IOException("connection reset")
                }
            }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val vm = ImportBackupViewModel(
            username = "alice", takenNames = emptySet(),
            waitingServers = mapOf(b.archiveId to "clone.alice.flagship.services"),
            clientFor = { c }, accountKek = { accountKek }, pollMs = 1, scope = scope,
        )
        vm.choose(listOf(LocalPickedFile(b.backupFile), LocalPickedFile(b.dataFile)))
        vm.send("clone.alice.flagship.services")
        waitFor { vm.phase.value.let { it is ImportBackupViewModel.Phase.Done || it is ImportBackupViewModel.Phase.Failed } }
        // The mock says it holds nothing, so the retry starts over from 0 and finishes.
        assertTrue("got ${vm.phase.value}", vm.phase.value is ImportBackupViewModel.Phase.Done)
        assertFalse(failNext)
    }

    @Test fun aFailedRestoreSaysTheServerKeepsWaiting() = runBlocking {
        val b = makeBackup()
        val c = client()
        c.restoreWaiting = ServerRestoreWaiting(b.archiveId, b.dataBytes, b.sha256)
        c.restoreFailure = "the backup's data file can't be opened: wrong key, or it was changed or cut short"
        val vm = importVM(c, waiting = mapOf(b.archiveId to "clone.alice.flagship.services"))
        vm.choose(listOf(LocalPickedFile(b.backupFile), LocalPickedFile(b.dataFile)))
        vm.send("clone.alice.flagship.services")
        waitFor { vm.phase.value is ImportBackupViewModel.Phase.Failed }
        val failed = vm.phase.value as ImportBackupViewModel.Phase.Failed
        assertTrue(failed.message, failed.message.contains("wrong key"))
        assertTrue(failed.keepsWaiting)
    }

    @Test fun aServerWaitingForAnotherBackupIsRefused() = runBlocking {
        val b = makeBackup()
        val c = client()
        c.restoreWaiting = ServerRestoreWaiting("ffeeddccbbaa99887766554433221100", 10, "ab".repeat(32))
        val vm = importVM(c, waiting = mapOf(b.archiveId to "clone.alice.flagship.services"))
        vm.choose(listOf(LocalPickedFile(b.backupFile), LocalPickedFile(b.dataFile)))
        vm.send("clone.alice.flagship.services")
        waitFor { vm.phase.value is ImportBackupViewModel.Phase.Failed }
        assertEquals("That server is waiting for a different backup.", (vm.phase.value as ImportBackupViewModel.Phase.Failed).message)
        assertTrue(c.restoreChunks.isEmpty())
    }

    @Test fun pickingSomethingElseExplainsWhy() = runBlocking {
        val f = File(tmp(), "x.txt").apply { writeText("hello\n") }
        val vm = importVM(client())
        vm.choose(listOf(LocalPickedFile(f)))
        assertEquals("x.txt isn't a Flagship backup file or data file.", vm.fileError)
        assertEquals(ImportBackupViewModel.Phase.Pick, vm.phase.value)
    }

    @Test fun describesEachApp() {
        assertEquals("Wiki: restored", ImportBackupViewModel.describe(com.flagshipserver.app.api.ServerRestoreApp("a", "Wiki", "done")))
        assertEquals("Wiki: skipped (already here)", ImportBackupViewModel.describe(com.flagshipserver.app.api.ServerRestoreApp("a", "Wiki", "skipped")))
        assertEquals("Wiki: couldn't be restored (no space)", ImportBackupViewModel.describe(com.flagshipserver.app.api.ServerRestoreApp("a", "Wiki", "failed", "no space")))
    }
}
