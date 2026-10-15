package com.flagshipserver.app.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger

class ArchiveDownloaderTest {
    private val blob = ByteArray(10_000) { ((it * 31 + 7) and 0xff).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(blob).joinToString("") { "%02x".format(it) }
    private fun dir(): File = Files.createTempDirectory("dl").toFile()
    private fun part(o: Long) = blob.copyOfRange(o.toInt(), minOf(o.toInt() + 1_000, blob.size))

    @Test fun downloadsPartsConcurrentlyAndChecksTheHash() = runBlocking {
        val d = dir()
        val inFlight = AtomicInteger()
        var maxInFlight = 0
        ArchiveDownloader.download(blob.size.toLong(), sha, File(d, "p"), File(d, "s"), chunkBytes = 1_000, parallel = 3, fetch = { o ->
            maxInFlight = maxOf(maxInFlight, inFlight.incrementAndGet())
            delay(5)
            inFlight.decrementAndGet()
            part(o)
        })
        assertTrue(File(d, "p").readBytes().contentEquals(blob))
        assertFalse(File(d, "s").exists())
        assertTrue("parts are fetched at once", maxInFlight > 1)
    }

    @Test fun resumesOnlyTheMissingParts() = runBlocking {
        val d = dir()
        try {
            ArchiveDownloader.download(blob.size.toLong(), sha, File(d, "p"), File(d, "s"), chunkBytes = 1_000, parallel = 1, fetch = { o ->
                if (o >= 4_000) error("boom")
                part(o)
            })
            fail("expected the first attempt to fail")
        } catch (_: IllegalStateException) {
        }
        val fetched = mutableListOf<Long>()
        ArchiveDownloader.download(blob.size.toLong(), sha, File(d, "p"), File(d, "s"), chunkBytes = 1_000, parallel = 2, fetch = { o ->
            synchronized(fetched) { fetched += o }
            part(o)
        })
        assertEquals((4_000L until 10_000L step 1_000L).toSet(), fetched.toSet())
        assertTrue(File(d, "p").readBytes().contentEquals(blob))
    }

    @Test fun refusesADamagedResult() = runBlocking {
        val d = dir()
        try {
            ArchiveDownloader.download(blob.size.toLong(), sha, File(d, "p"), File(d, "s"), chunkBytes = 1_000, fetch = { o ->
                part(o).also { if (o == 2_000L) it[0] = (it[0].toInt() xor 1).toByte() }
            })
            fail("expected damaged")
        } catch (e: ArchiveDownloader.DownloadException) {
            assertTrue(e.message!!.contains("doesn't match"))
        }
        assertFalse(File(d, "p").exists())
    }

    @Test fun refusesAShortPart() = runBlocking {
        val d = dir()
        try {
            ArchiveDownloader.download(3_000, null, File(d, "p"), File(d, "s"), chunkBytes = 1_000, fetch = { ByteArray(10) })
            fail("expected short")
        } catch (e: ArchiveDownloader.DownloadException) {
            assertTrue(e.message!!.contains("short"))
        }
    }
}
