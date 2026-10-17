// The server page's backup flow and Home's Import a backup flow against the
// mock box. Mirrors the iOS ServerArchiveViewModelTests.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.PeerRootArchive
import com.flagshipserver.app.api.PeerRootRequest
import com.flagshipserver.app.api.PeerRootSummary
import com.flagshipserver.app.api.ServerArchiveStartRequest
import com.flagshipserver.app.api.ServerBackupKdf
import com.flagshipserver.app.api.ServerBackupSlot
import com.flagshipserver.app.api.ServerRestoreCommitRequest
import com.flagshipserver.app.api.ServerRestoreStartRequest
import com.flagshipserver.app.api.ServerRestoreWaiting
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PeerBackup
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
        assertEquals(c.archiveBundle.size.toLong(), ready.bytes)
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
        assertEquals("home-1970-01-01.flagship", saved.file.name)
        assertArrayEquals("one file: header, metadata part, data part", c.archiveBundle, saved.file.readBytes())
        assertTrue("the server drops its copy once the file is safe here", c.archiveForgotten)
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
        assertArrayEquals(c.archiveBundle, saved.file.readBytes())
    }

    @Test fun aBackupAlreadyMadeIsFollowed() = runBlocking {
        val c = client()
        c.archiveStarts += ServerArchiveStartRequest("00112233445566778899aabbccddeeff", "00".repeat(32), emptyList())
        val vm = backupVM(c)
        vm.load()
        assertEquals(ServerBackupViewModel.Phase.Ready(c.archiveBundle.size.toLong()), vm.phase.value)
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
        /** The one `.flagship` file. */
        val file: File,
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
        if (corruptData) data[data.size - 1] = (data[data.size - 1].toInt() xor 1).toByte()
        return Backup(writeBundle(dir, name, ServerBackupFormat.serialize(file).toByteArray(), data), id, key, data.size.toLong(), sha)
    }

    private fun writeBundle(dir: File, name: String, meta: ByteArray, data: ByteArray): File =
        File(dir, "$name-2026-10-14.flagship").apply { writeBytes(ServerBackupFormat.bundleHeader(meta.size) + meta + data) }

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
        vm.choose(LocalPickedFile(b.file))
        assertEquals(ImportBackupViewModel.Phase.Name, vm.phase.value)
        assertTrue(vm.fileSummary, vm.fileSummary.startsWith("home-2026-10-14.flagship ("))
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
        vm.choose(LocalPickedFile(b.file))
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
        vm.choose(LocalPickedFile(b.file))
        assertEquals(ImportBackupViewModel.Phase.Passcode, vm.phase.value)
        vm.passcode = "wrong one"
        vm.unlock()
        assertEquals(ImportBackupViewModel.Phase.Passcode, vm.phase.value)
        assertEquals("That passcode doesn't open this backup.", vm.fileError)
    }

    @Test fun theRealPasscodeOpensABackupOfAnotherAccount() = runBlocking {
        val b = makeBackup()
        val bytes = b.file.readBytes()
        val layout = ServerBackupFormat.parseBundleHeader(bytes.copyOf(16), bytes.size.toLong())
        val raw = ServerBackupFormat.parse(bytes.copyOfRange(16, layout.dataOffset.toInt()))
        val pass = ServerBackupFormat.passcodeSlot(raw.archiveId, b.contentKey, "correct horse battery staple", m = 64, t = 1, p = 1)
        writeBundle(b.file.parentFile!!, "home", ServerBackupFormat.serialize(raw.copy(slots = listOf(pass) + raw.slots)).toByteArray(), bytes.copyOfRange(layout.dataOffset.toInt(), bytes.size))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val vm = ImportBackupViewModel(
            username = "alice", takenNames = emptySet(), clientFor = { client() },
            accountKek = { ByteArray(32) }, pollMs = 1, scope = scope,
        )
        vm.choose(LocalPickedFile(b.file))
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
        vm.choose(LocalPickedFile(b.file))
        assertEquals(ImportBackupViewModel.Phase.Pick, vm.phase.value)
        assertEquals("This backup was changed or is damaged.", vm.fileError)
        assertNull("it asks for the file again", vm.fileName)
    }

    @Test fun aServerWaitingForThisBackupIsOffered() = runBlocking {
        val b = makeBackup()
        val vm = importVM(client(), waiting = mapOf(b.archiveId to "clone.alice.flagship.services"))
        vm.choose(LocalPickedFile(b.file))
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
        vm.choose(LocalPickedFile(b.file))
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
        vm.choose(LocalPickedFile(b.file))
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
        vm.choose(LocalPickedFile(b.file))
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
        vm.choose(LocalPickedFile(b.file))
        vm.send("clone.alice.flagship.services")
        waitFor { vm.phase.value is ImportBackupViewModel.Phase.Failed }
        assertEquals("That server is waiting for a different backup.", (vm.phase.value as ImportBackupViewModel.Phase.Failed).message)
        assertTrue(c.restoreChunks.isEmpty())
    }

    @Test fun pickingSomethingElseExplainsWhy() = runBlocking {
        val vm = importVM(client())
        vm.choose(LocalPickedFile(File(tmp(), "x.txt").apply { writeText("hello\n") }))
        assertEquals("This file is too short to be a Flagship backup.", vm.fileError)
        assertEquals(ImportBackupViewModel.Phase.Pick, vm.phase.value)
        vm.choose(LocalPickedFile(File(tmp(), "y.txt").apply { writeText("this is a plain text file, not a backup\n") }))
        assertEquals("This file isn't a Flagship backup.", vm.fileError)
        assertNull(vm.fileName)
    }

    @Test fun aTruncatedFileIsRefusedWithASentence() = runBlocking {
        val b = makeBackup()
        val bytes = b.file.readBytes()
        val layout = ServerBackupFormat.parseBundleHeader(bytes.copyOf(16), bytes.size.toLong())
        val vm = importVM(client())
        // Cut inside the metadata part: the header says more than the file holds.
        val cut = File(tmp(), "cut.flagship").apply { writeBytes(bytes.copyOf(40)) }
        vm.choose(LocalPickedFile(cut))
        assertEquals("This backup is cut short: it ends before its data.", vm.fileError)
        assertEquals(ImportBackupViewModel.Phase.Pick, vm.phase.value)
        // Cut inside the data part: the metadata opens, the data check refuses it.
        val short = File(tmp(), "short.flagship").apply { writeBytes(bytes.copyOf(layout.dataOffset.toInt() + 1000)) }
        vm.choose(LocalPickedFile(short))
        assertEquals("This backup was changed or is damaged.", vm.fileError)
        assertEquals(ImportBackupViewModel.Phase.Pick, vm.phase.value)
    }

    @Test fun aRestoreWithAFailedAppEndsAndNamesIt() = runBlocking {
        val b = makeBackup()
        val c = client()
        c.restoreWaiting = ServerRestoreWaiting(b.archiveId, b.dataBytes, b.sha256)
        c.restoreApps = listOf(
            com.flagshipserver.app.api.ServerRestoreApp("alice--wiki", "Wiki", "done"),
            com.flagshipserver.app.api.ServerRestoreApp("alice--notes", "Notes", "failed", "its image didn't build"),
        )
        val restored = mutableListOf<String>()
        val vm = importVM(c, waiting = mapOf(b.archiveId to "clone.alice.flagship.services"), onRestored = { restored += it })
        vm.choose(LocalPickedFile(b.file))
        vm.send("clone.alice.flagship.services")
        waitFor { vm.phase.value is ImportBackupViewModel.Phase.Done }
        val done = vm.phase.value as ImportBackupViewModel.Phase.Done
        assertEquals(listOf("Restored 1 app", "Couldn't restore: Notes: its image didn't build"), ImportBackupViewModel.resultLines(done.apps))
        assertEquals("Home stops showing it waiting", listOf("clone.alice.flagship.services"), restored)
    }

    @Test fun aMultiGigabyteFileIsStreamedNeverHeld() = runBlocking {
        // A sparse file: the data part is 2.2 GB of zeros after its first line,
        // so offsets pass Int.MAX_VALUE without the disk or the heap holding it.
        val dir = tmp()
        val id = "00112233445566778899aabbccddeeff"
        val key = ByteArray(32) { 0x42 }
        val magic = ServerBackupFormat.DATA_MAGIC.toByteArray()
        val dataBytes = 2_200_000_000L
        val h = MessageDigest.getInstance("SHA-256")
        h.update(magic)
        val zeros = ByteArray(1 shl 20)
        var left = dataBytes - magic.size
        while (left > 0) {
            val n = minOf(left, zeros.size.toLong()).toInt()
            h.update(zeros, 0, n)
            left -= n
        }
        val sha = HexUtil.encode(h.digest())
        val body = """{"createdAt":1792000000000,"server":{"name":"big","domain":"big.alice.flagship.services","bootUnlockMode":"auto","diskEncryption":"luks"},""" +
            """"apps":[],"left":[],"includes":[],"excludes":[],""" +
            """"data":{"fileName":"big.flagship-data","bytes":$dataBytes,"sha256":"$sha","frameBytes":1048576}}"""
        val account = ServerBackupFormat.wrapAccountSlot(id, key, accountKek, ByteArray(12))
        val meta = ServerBackupFormat.serialize(ServerBackupFormat.sealFile(id, key, listOf(account), body.toByteArray(), ByteArray(12) { 1 })).toByteArray()
        val f = File(dir, "big.flagship")
        java.io.RandomAccessFile(f, "rw").use { raf ->
            raf.write(ServerBackupFormat.bundleHeader(meta.size))
            raf.write(meta)
            raf.write(magic)
            raf.setLength(16L + meta.size + dataBytes)
        }
        val c = client()
        c.restoreWaiting = ServerRestoreWaiting(id, dataBytes, sha)
        val vm = importVM(c, waiting = mapOf(id to "clone.alice.flagship.services"))
        vm.choose(LocalPickedFile(f))
        assertEquals(ImportBackupViewModel.Phase.ChooseTarget("clone.alice.flagship.services"), vm.phase.value)
        vm.send("clone.alice.flagship.services")
        waitFor(timeoutMs = 300_000) { vm.phase.value is ImportBackupViewModel.Phase.Done }
        assertEquals(dataBytes, c.restoreChunks.sumOf { it.second.toLong() })
        assertEquals("the last part starts past 2 GiB", (dataBytes - 1) / (4L * 1024 * 1024) * 4L * 1024 * 1024, c.restoreChunks.last().first)
    }

    @Test fun describesEachApp() {
        assertEquals("Wiki: restored", ImportBackupViewModel.describe(com.flagshipserver.app.api.ServerRestoreApp("a", "Wiki", "done")))
        assertEquals("Wiki: skipped (already here)", ImportBackupViewModel.describe(com.flagshipserver.app.api.ServerRestoreApp("a", "Wiki", "skipped")))
        assertEquals("Wiki: couldn't be restored (no space)", ImportBackupViewModel.describe(com.flagshipserver.app.api.ServerRestoreApp("a", "Wiki", "failed", "no space")))
    }

    // ── Restore from other servers (docs/peer-backup.md §9) ───────

    private val lostServer = "home.alice.flagship.services"

    private class FakePeers(
        val root: PeerRootSummary?,
        val error: Throwable? = null,
        override val lostChoices: List<String> = listOf("home.alice.flagship.services"),
    ) : PeerRestoreSource {
        val described = mutableListOf<String>()
        override suspend fun describe(lost: String): PeerRootSummary {
            described += lost
            error?.let { throw it }
            return root!!
        }
        override suspend fun pbkHex(lost: String): String = "11".repeat(32)
    }

    private fun rootOf(b: Backup, bytes: Long = b.dataBytes): PeerRootSummary {
        val whole = b.file.readBytes()
        val layout = ServerBackupFormat.parseBundleHeader(whole.copyOf(16), whole.size.toLong())
        val meta = String(whole.copyOfRange(16, layout.dataOffset.toInt()), Charsets.UTF_8)
        return PeerRootSummary(
            serverId = lostServer,
            archive = PeerRootArchive(b.archiveId, 1_792_000_000_000, bytes, b.sha256, meta),
            holders = 3,
            needed = 2,
            keepUntil = 1_799_776_000_000,
        )
    }

    private fun peerVM(
        c: MockScreensClient,
        peers: PeerRestoreSource,
        waiting: Map<String, String> = emptyMap(),
        kek: ByteArray = accountKek,
    ): ImportBackupViewModel {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return ImportBackupViewModel(
            username = "alice", takenNames = emptySet(), waitingServers = waiting,
            clientFor = { c }, accountKek = { kek }, peers = peers, pollMs = 1, scope = scope,
        )
    }

    @Test fun peerRestoreStartsOnTheLostServerPicker() = runBlocking {
        val vm = peerVM(client(), FakePeers(null))
        assertEquals(ImportBackupViewModel.Phase.PickLost, vm.phase.value)
        assertTrue(vm.isPeerRestore)
        assertEquals(listOf(lostServer), vm.lostChoices)
    }

    @Test fun peerRestoreFindsTheRecordOpensItWithTheAccountKeyAndAsksForAName() = runBlocking {
        val b = makeBackup()
        val peers = FakePeers(rootOf(b))
        val vm = peerVM(client(), peers)
        vm.lost = "  ${lostServer.uppercase()} "
        vm.findPeerBackup()
        assertEquals(listOf(lostServer), peers.described)
        assertEquals(ImportBackupViewModel.Phase.Name, vm.phase.value)
        assertEquals("home", vm.name)
        val summary = vm.summary!!
        assertTrue(summary, summary.contains("Backup of $lostServer"))
        assertTrue(summary, summary.contains("3 servers hold its pieces; 2 bring it back."))
        assertTrue(summary, summary.contains("Apps: Wiki."))
        vm.create()
        assertEquals(
            ImportBackupViewModel.RestoreTarget(b.archiveId, b.dataBytes, b.sha256),
            vm.createTarget?.restore,
        )
    }

    @Test fun peerRestoreGetsThePiecesThenCommitsAndRestores() = runBlocking {
        val b = makeBackup()
        val c = client()
        c.restoreWaiting = ServerRestoreWaiting(b.archiveId, b.dataBytes, b.sha256)
        val restored = mutableListOf<String>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val vm = ImportBackupViewModel(
            username = "alice", takenNames = emptySet(),
            waitingServers = mapOf(b.archiveId to "clone.alice.flagship.services"),
            clientFor = { c }, accountKek = { accountKek }, peers = FakePeers(rootOf(b)),
            onRestored = { restored += it }, pollMs = 1, scope = scope,
        )
        vm.lost = lostServer
        vm.findPeerBackup()
        assertEquals(ImportBackupViewModel.Phase.ChooseTarget("clone.alice.flagship.services"), vm.phase.value)
        vm.send("clone.alice.flagship.services")
        waitFor { vm.phase.value is ImportBackupViewModel.Phase.Done }
        assertEquals(listOf(PeerRootRequest(lostServer, "11".repeat(32))), c.peerFetches)
        assertTrue("nothing is uploaded from the phone", c.restoreChunks.isEmpty())
        assertEquals(listOf(ServerRestoreCommitRequest(HexUtil.encode(b.contentKey))), c.restoreCommits)
        assertEquals(listOf("clone.alice.flagship.services"), restored)
    }

    @Test fun peerRestoreSaysTheBoxsSentenceWhenTheFetchFails() = runBlocking {
        val b = makeBackup()
        val mock = client()
        mock.restoreWaiting = ServerRestoreWaiting(b.archiveId, b.dataBytes, b.sha256)
        val c = object : com.flagshipserver.app.api.ScreensClient by mock {
            override suspend fun serverRestoreStatus() = com.flagshipserver.app.api.ServerRestoreStatusResponse(
                waiting = mock.restoreWaiting,
                restore = com.flagshipserver.app.api.ServerRestoreStatus(
                    archiveId = b.archiveId, state = "uploading", bytes = b.dataBytes,
                    reason = "The backup from other servers came back the wrong size.",
                ),
            )
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val vm = ImportBackupViewModel(
            username = "alice", takenNames = emptySet(),
            waitingServers = mapOf(b.archiveId to "clone.alice.flagship.services"),
            clientFor = { c }, accountKek = { accountKek }, peers = FakePeers(rootOf(b)), pollMs = 1, scope = scope,
        )
        vm.lost = lostServer
        vm.findPeerBackup()
        vm.send("clone.alice.flagship.services")
        waitFor { vm.phase.value is ImportBackupViewModel.Phase.Failed }
        val failed = vm.phase.value as ImportBackupViewModel.Phase.Failed
        assertEquals("The restore failed: The backup from other servers came back the wrong size.", failed.message)
        assertTrue(failed.keepsWaiting)
    }

    @Test fun peerRestoreRefusesARecordThisAccountCantOpen() = runBlocking {
        val b = makeBackup()
        val vm = peerVM(client(), FakePeers(rootOf(b)), kek = ByteArray(32))
        vm.lost = lostServer
        vm.findPeerBackup()
        assertEquals(ImportBackupViewModel.Phase.PickLost, vm.phase.value)
        assertEquals("This backup can't be opened with this account's key.", vm.fileError)
    }

    @Test fun peerRestoreRefusesARecordThatDoesntMatchItsFile() = runBlocking {
        val b = makeBackup()
        val vm = peerVM(client(), FakePeers(rootOf(b, bytes = b.dataBytes + 1)))
        vm.lost = lostServer
        vm.findPeerBackup()
        assertEquals(ImportBackupViewModel.Phase.PickLost, vm.phase.value)
        assertEquals("The backup record doesn't match its file. Nothing was restored.", vm.fileError)
    }

    @Test fun peerRestoreShowsWhyNothingWasFound() = runBlocking {
        val vm = peerVM(client(), FakePeers(null, error = PeerBackup.PeerBackupException("No peer backup of that server was found.")))
        vm.lost = lostServer
        vm.findPeerBackup()
        assertEquals(ImportBackupViewModel.Phase.PickLost, vm.phase.value)
        assertEquals("No peer backup of that server was found.", vm.fileError)
        vm.lost = "a|b"
        val sentence = peerVM(client(), FakePeers(null))
        sentence.lost = "a|b"
        sentence.findPeerBackup()
        assertEquals("That isn't a server address.", sentence.fileError)
    }
}
