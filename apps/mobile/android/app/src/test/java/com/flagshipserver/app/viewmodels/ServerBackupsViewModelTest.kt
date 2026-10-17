// The server page's Backups section against the mock box (which answers like
// serverArchive/service.ts and backupPolicy/http.ts). Mirrors the iOS
// ServerBackupsViewModelTests.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BackupSchedule
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.ArchiveKeys
import com.flagshipserver.app.core.BackupsText
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerArchive
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class ServerBackupsViewModelTest {
    private val dirs = mutableListOf<File>()
    private val kp = Ed25519Sign.KeyPair.newKeyPair()
    private val umk = ByteArray(32) { 7 }
    private val fqdn = "home.bright-maple.flagship.services"

    @After fun cleanUp() = dirs.forEach { it.deleteRecursively() }

    private fun vm(c: MockScreensClient, admin: Boolean = true, needsPrompt: Boolean = false, mints: MutableList<Int> = mutableListOf()) =
        ServerBackupsViewModel(
            serverFqdn = "Home.bright-maple.flagship.services",
            client = c,
            isAdmin = admin,
            sign = { Ed25519Sign(kp.privateKey).sign(it) },
            mintKeys = { n -> mints += n; ArchiveKeys.mint(umk, n) },
            signingNeedsPrompt = { needsPrompt },
            downloadDir = { Files.createTempDirectory("saved-backups").toFile().also { dirs += it } },
            pollMs = 1,
        )

    private fun emptyBox() = MockScreensClient(simulatedLatencyMs = 0).apply {
        backupKeyPool.clear()
        savedBackupsList.clear()
        backupLastRun = null
    }

    @Test fun anAdminDepositsTheKeysTheBoxAsksForInOneBatch() = runBlocking {
        val c = emptyBox()
        val mints = mutableListOf<Int>()
        val vm = vm(c, mints = mints)
        vm.load()
        assertEquals("one batch of the keys the server wants", listOf(800 - 0).map { minOf(it, 400) }, mints)
        val d = c.backupKeyDeposits.single()
        assertEquals(fqdn, d.deposit.serverDomain)
        assertEquals(400, d.deposit.count)
        assertEquals(ArchiveKeys.digest(d.keys), d.deposit.digest)
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(d.signature)!!, d.deposit.canonicalBytes())
        // Each kek is this account's key for that archive id.
        assertEquals(HexUtil.encode(ServerArchive.deriveKey(umk, d.keys[0].archiveId)!!), d.keys[0].kekHex)
        assertEquals(400, vm.view!!.keysLeft)
        assertNotNull("the next backup shows once the server has keys", BackupsText.nextLine(vm.view!!))
        assertFalse(vm.needsApproval)
    }

    @Test fun whenSigningWouldPromptTheAdminTapsApproveInstead() = runBlocking {
        val c = emptyBox()
        val vm = vm(c, needsPrompt = true)
        vm.load()
        assertTrue(vm.needsApproval)
        assertTrue("never a prompt on page open", c.backupKeyDeposits.isEmpty())
        assertTrue(vm.deposit())
        assertEquals(1, c.backupKeyDeposits.size)
        assertFalse(vm.needsApproval)
    }

    @Test fun aNonAdminNeverDepositsAndSeesTheBoxsReason() = runBlocking {
        val c = emptyBox()
        val vm = vm(c, admin = false)
        vm.load()
        assertTrue(c.backupKeyDeposits.isEmpty())
        assertFalse(vm.deposit())
        assertEquals(
            "an admin device of your account hasn't approved backups for this server yet: open this server in the Flagship app on an admin device",
            vm.view!!.waitingReason,
        )
        vm.backUpNow()
        assertEquals("a non-admin device sends no order", 0, c.backupRuns)
        assertFalse(vm.saveSchedule(BackupSchedule()))
        assertTrue(c.backupSchedulePuts.isEmpty())
    }

    @Test fun noDepositWhileThePoolIsFull() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        val mints = mutableListOf<Int>()
        vm(c, mints = mints).load()
        assertTrue(mints.isEmpty())
        assertTrue(c.backupKeyDeposits.isEmpty())
    }

    @Test fun backUpNowRunsShowsProgressAndLists() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(c)
        vm.load()
        val before = vm.view!!.backups.size
        val statuses = mutableListOf<String>()
        val client = object : com.flagshipserver.app.api.ScreensClient by c {
            override suspend fun savedBackups() = c.savedBackups().also { statuses += BackupsText.statusLine(it) }
        }
        val vm2 = ServerBackupsViewModel(fqdn, client, true, { Ed25519Sign(kp.privateKey).sign(it) }, { ArchiveKeys.mint(umk, it) }, downloadDir = { File("/tmp") }, pollMs = 1)
        vm2.load()
        vm2.backUpNow()
        assertTrue(statuses.toString(), statuses.any { it.startsWith("Backing up… Wiki (1/2)") })
        assertNull(vm2.view!!.running)
        assertEquals(before + 1, vm2.view!!.backups.size)
        assertEquals("now", vm2.view!!.backups.first().trigger)
        assertTrue(BackupsText.statusLine(vm2.view!!).startsWith("Last backup: "))
    }

    @Test fun noKeysOnBackUpNowDepositsThenRetriesOnce() = runBlocking {
        val c = emptyBox()
        val vm = vm(c, needsPrompt = true)
        vm.load()
        assertTrue(c.backupKeyDeposits.isEmpty())
        vm.backUpNow()
        assertEquals(1, c.backupKeyDeposits.size)
        assertEquals(1, c.backupRuns)
        assertEquals(1, vm.view!!.backups.size)
        assertNull(vm.actionError)
    }

    @Test fun aFailedRunShowsTheBoxsSentence() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        c.backupRunFailure = "needs about 12.0 GB, has 3.1 GB"
        val vm = vm(c)
        vm.load()
        vm.backUpNow()
        assertEquals("The last backup failed: needs about 12.0 GB, has 3.1 GB.", BackupsText.failedLine(vm.view!!))
    }

    @Test fun theScheduleIsSavedInUtcAndRefusalsAreTheBoxsSentence() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(c)
        vm.load()
        val s = BackupSchedule("weekly", 120, 2, 7, 4)
        assertTrue(vm.saveSchedule(s))
        assertEquals(s, c.backupSchedulePuts.single())
        assertFalse(vm.saveSchedule(BackupSchedule("daily", 60, 0, 0, 0)))
        assertEquals("keep at least one backup", vm.actionError)
    }

    @Test fun deleteRemovesItFromTheList() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(c)
        vm.load()
        val id = vm.view!!.backups.last().archiveId
        vm.delete(id)
        assertEquals(listOf(id), c.backupDeletes)
        assertTrue(vm.view!!.backups.none { it.archiveId == id })
    }

    @Test fun downloadIsTheOneFileAndTheBoxKeepsItsCopy() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        c.archiveBytes = ByteArray(9 * 1024 * 1024) { (it and 0xff).toByte() }
        c.savedBackupsList.clear()
        c.backupKeyPool += "%032x".format(77)
        val vm = vm(c)
        vm.load()
        vm.backUpNow()
        val b = vm.view!!.backups.first()
        val f = vm.download(b)!!
        assertEquals(b.bundleFileName, f.name)
        assertTrue(f.name.endsWith(".flagship"))
        assertArrayEquals(c.archiveBundle, f.readBytes())
        assertTrue("saved backups stay on the server", c.savedBackupsList.any { it.archiveId == b.archiveId })
    }

    @Test fun policyChangeIsSignedAndARefusalIsTheBoxsSentence() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(c)
        vm.load()
        assertTrue(vm.changePolicy("peer", 99))
        val post = c.backupPolicyPosts.single()
        assertEquals("peer", post.order.policy)
        assertEquals(0L, post.order.phoneReserveBytes)
        assertEquals(fqdn, post.order.serverDomain)
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(post.signatureHex)!!, post.order.canonicalBytes())
        assertEquals("peer", vm.policy!!.policy.policy)
        assertNotNull("the peer engine's status shows", vm.policy!!.peer)

        assertFalse(vm.changePolicy("phone", 2 * BackupsText.GB))
        assertEquals(
            "This server holds 3.2 GB of app data, more than the 2.0 GB your device would keep. Reserve at least 3.2 GB on that device, or remove apps or data first.",
            vm.policyError,
        )
        assertEquals("peer", vm.policy!!.policy.policy)
    }

    @Test fun overTheLimitShowsTheBoxsReason() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        c.backupUsedBytes = 40 * BackupsText.GB
        val vm = vm(c)
        vm.load()
        assertTrue(vm.policy!!.cap.overLimit)
        assertEquals(
            "This server holds 40 GB of app data, over its backup limit of 32 GB (the space your device keeps for its backup). Remove apps or data, or change the backup policy on the server page.",
            vm.policy!!.cap.overReason,
        )
    }

    @Test fun noBackupsPolicyStopsTheSchedule() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(c)
        vm.load()
        assertTrue(vm.changePolicy("none", 0))
        assertFalse(vm.view!!.scheduleActive)
        assertNull(vm.view!!.nextRunAt)
    }
}
