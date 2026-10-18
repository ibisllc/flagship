// "Keep a copy on this phone": the background fetch of each server's newest
// saved backup (one .flagship file), its free-space check, resuming, and
// keeping the newest two that fit the reserve. Mirrors the iOS
// PhoneBackupCopiesTests.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.BackupPolicyState
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.SavedBackup
import com.flagshipserver.app.api.ScreensClient
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PhoneBackupCopiesTest {
    private val root: File = Files.createTempDirectory("phone-copies").toFile()
    private val server = "home.bright-maple.flagship.services"
    private val gb = BackupsText.GB

    @After fun cleanUp() {
        root.deleteRecursively()
    }

    private fun copies(): PhoneBackupCopies {
        val prefs = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("phone-copies-test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        return PhoneBackupCopies(root, prefs)
    }

    private fun meta(id: String, at: Long, bytes: Long) = SavedBackup(
        archiveId = id, createdAt = at, bytes = bytes, sha256 = "ab".repeat(32),
        backupFileName = "b.flagship-backup", dataFileName = "b.flagship-data", bundleFileName = "b-$id.flagship", bundleBytes = bytes,
    )

    @Test fun theNewestAlwaysStaysThePreviousOnlyWhileBothFit() {
        val newest = meta("2", 2, 10 * gb)
        val prev = meta("1", 1, 10 * gb)
        assertEquals(setOf("2", "1"), PhoneBackupCopies.keepIds(listOf(newest, prev, meta("0", 0, gb)), 32 * gb))
        assertEquals(setOf("2"), PhoneBackupCopies.keepIds(listOf(newest, prev), 16 * gb))
        assertEquals("no reserve (policy not chosen yet): the newest two", setOf("2", "1"), PhoneBackupCopies.keepIds(listOf(newest, prev), 0))
        assertEquals(emptySet<String>(), PhoneBackupCopies.keepIds(emptyList(), 0))
    }

    @Test fun fetchesTheNewestOnceChecksItAndKeepsTwo() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        c.archiveBytes = ByteArray(5 * 1024 * 1024) { (it % 251).toByte() }
        c.savedBackupsList.clear()
        val store = copies()
        val fetcher = PhoneBackupFetcher(store, { c }, freeBytes = { 100 * gb })
        for (i in 1..3) {
            c.backupKeyPool.add(0, "%032x".format(500 + i))
            Thread.sleep(5)
            c.runBackupNow()
            while (c.savedBackups().running != null) Unit
            fetcher.run(listOf(server))
        }
        val kept = store.copies(server)
        assertEquals("the newest two (32 GB reserve)", c.savedBackupsList.take(2).map { it.archiveId }, kept.map { it.meta.archiveId })
        assertArrayEquals("one .flagship file", c.archiveBundle, kept.first().file.readBytes())
        assertTrue(kept.first().file.name.endsWith(".flagship"))
        // Nothing new: nothing fetched again.
        var chunks = 0
        val counting = object : ScreensClient by c {
            override suspend fun savedBackupBundleChunk(archiveId: String, offset: Long): ByteArray { chunks++; return c.savedBackupBundleChunk(archiveId, offset) }
        }
        PhoneBackupFetcher(store, { counting }, freeBytes = { 100 * gb }).run(listOf(server))
        assertEquals(0, chunks)
    }

    @Test fun listsEveryServerThatHoldsACopyForTheRestorePicker() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        val store = copies()
        assertTrue("nothing kept yet", store.servers().isEmpty())
        PhoneBackupFetcher(store, { c }, freeBytes = { 100 * gb }).run(listOf(server))
        assertEquals(listOf(server), store.servers())
        // A server whose only folder is empty holds no copy and is not listed.
        File(root, "office.bright-maple.flagship.services").mkdirs()
        assertEquals(listOf(server), store.servers())
    }

    @Test fun notEnoughFreeSpaceSkipsWithASentence() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        val store = copies()
        PhoneBackupFetcher(store, { c }, freeBytes = { 1024 }).run(listOf(server))
        assertTrue(store.copies(server).isEmpty())
        val need = c.savedBackupsList.first().totalBytes + PhoneBackupCopies.HEADROOM_BYTES
        assertEquals("This phone needs about ${ServerArchive.formatBytes(need)} free to keep a copy.", store.note(server))
    }

    @Test fun onlyPhoneSideOrUnchosenPoliciesAndOnlyWhenTurnedOn() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        val store = copies()
        c.backupPolicyState = BackupPolicyState("peer", 0, 1)
        PhoneBackupFetcher(store, { c }, freeBytes = { 100 * gb }).run(listOf(server))
        assertTrue(store.copies(server).isEmpty())
        c.backupPolicyState = BackupPolicyState("phone", 32 * gb, 2)
        store.setKeepCopy(server, false)
        PhoneBackupFetcher(store, { c }, freeBytes = { 100 * gb }).run(listOf(server))
        assertTrue(store.copies(server).isEmpty())
        store.setKeepCopy(server, true)
        PhoneBackupFetcher(store, { c }, freeBytes = { 100 * gb }).run(listOf(server))
        assertEquals(1, store.copies(server).size)
        assertNull(store.note(server))
    }

    @Test fun anInterruptedFetchResumesNextRun() = runBlocking {
        val c = MockScreensClient(simulatedLatencyMs = 0)
        c.archiveBytes = ByteArray(13 * 1024 * 1024) { (it % 253).toByte() }
        c.savedBackupsList.clear()
        c.runBackupNow()
        while (c.savedBackups().running != null) Unit
        val store = copies()
        val asked = mutableListOf<Long>()
        var cut = true
        val flaky = object : ScreensClient by c {
            override suspend fun savedBackupBundleChunk(archiveId: String, offset: Long): ByteArray {
                if (cut && offset >= 8L * 1024 * 1024) {
                    // Let the parts before it land first, as a real cut would.
                    kotlinx.coroutines.delay(100)
                    throw java.io.IOException("Wi-Fi went away")
                }
                asked += offset
                return c.savedBackupBundleChunk(archiveId, offset)
            }
        }
        PhoneBackupFetcher(store, { flaky }, freeBytes = { 100 * gb }).run(listOf(server))
        assertTrue(store.copies(server).isEmpty())
        cut = false
        val before = asked.toSet()
        asked.clear()
        PhoneBackupFetcher(store, { flaky }, freeBytes = { 100 * gb }).run(listOf(server))
        assertEquals(1, store.copies(server).size)
        assertTrue("the parts already in aren't fetched again", asked.none { it in before })
        assertArrayEquals(c.archiveBundle, store.copies(server).first().file.readBytes())
    }

    /** A multi-GB file resumes with the parts already in kept on disk: only
     *  the missing tail is fetched, and the whole file's SHA-256 is checked
     *  (a sparse file: no GBs on disk or in memory). */
    @Test fun aMultiGigabyteDownloadResumesPastTwoGiB() = runBlocking {
        val total = 2_300_000_000L
        val chunk = ArchiveDownloader.CHUNK_BYTES
        val zeros = ByteArray(chunk.toInt())
        val h = MessageDigest.getInstance("SHA-256")
        var left = total
        while (left > 0) {
            val n = minOf(left, chunk).toInt()
            h.update(zeros, 0, n)
            left -= n
        }
        val sha = HexUtil.encode(h.digest())
        val file = File(root, "big.part")
        java.io.RandomAccessFile(file, "rw").use { it.setLength(total) }
        val state = File(root, "big.json")
        val offsets = (0 until total step chunk).toList()
        val tail = offsets.takeLast(3)
        state.writeText(
            kotlinx.serialization.json.Json.encodeToString(
                ArchiveDownloader.State.serializer(),
                ArchiveDownloader.State(total, sha, offsets.dropLast(3).toSet()),
            ),
        )
        val fetched = java.util.Collections.synchronizedList(mutableListOf<Long>())
        ArchiveDownloader.download(total, sha, file, state, fetch = { off ->
            fetched += off
            ByteArray(minOf(chunk, total - off).toInt())
        })
        assertEquals(tail.toSet(), fetched.toSet())
        assertTrue(tail.first() > Int.MAX_VALUE)
        assertEquals(total, file.length())
        if (state.exists()) fail("the state goes once the file checks out")
    }
}
