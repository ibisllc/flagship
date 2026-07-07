package com.flagshipserver.app.burner.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayInputStream

/**
 * Exercises the offset/region additions to [MassStorageWriter]: writeRegion at a
 * non-zero start LBA, writeSectors (small padded control writes), and readSectors
 * (the MBR read-modify-write primitive). The LBA math is pinned exactly against a
 * recording fake disk.
 */
class MassStorageWriterRegionTest {
    @Test
    fun writeImageStillStartsAtLbaZero() {
        val dev = RecordingDiskDevice(blockSize = 512, capacityBlocks = 4096)
        val src = ByteArray(2048) { (it and 0xFF).toByte() }
        MassStorageWriter(dev, maxWriteBytes = 1024).writeImage(ByteArrayInputStream(src), src.size.toLong(), 512)
        assertEquals(listOf(0L to 2, 2L to 2), dev.writes)
    }

    @Test
    fun writeRegionIssuesSequentialWritesFromStartLba() {
        val dev = RecordingDiskDevice(blockSize = 512, capacityBlocks = 65_536)
        val src = ByteArray(2048) { (it and 0xFF).toByte() }
        // 1024 B/write = 2 blocks/write ⇒ two WRITE(10)s starting at 1000.
        val written = MassStorageWriter(dev, maxWriteBytes = 1024)
            .writeRegion(ByteArrayInputStream(src), src.size.toLong(), startLba = 1000, blockSize = 512)
        assertEquals(2048L, written)
        assertEquals(listOf(1000L to 2, 1002L to 2), dev.writes)
    }

    @Test
    fun writeSectorsPadsTailAndPlacesAtLba() {
        val dev = RecordingDiskDevice(blockSize = 512, capacityBlocks = 4096)
        val bytes = ByteArray(700) { ((it + 1) and 0xFF).toByte() } // not a block multiple
        MassStorageWriter(dev).writeSectors(bytes, startLba = 50, blockSize = 512)
        assertEquals(listOf(50L to 2), dev.writes) // ceil(700/512) = 2 blocks
        val back = MassStorageWriter(dev).readSectors(startLba = 50, count = 2, blockSize = 512)
        assertArrayEquals(bytes, back.copyOfRange(0, 700))
        for (i in 700 until 1024) assertEquals(0, back[i].toInt())
    }

    @Test
    fun writeSectorsThenReadSectorsRoundTrips() {
        val dev = RecordingDiskDevice(blockSize = 512, capacityBlocks = 8192)
        val w = MassStorageWriter(dev)
        val vol = ByteArray(4096) { (it % 251).toByte() }
        w.writeSectors(vol, startLba = 2048, blockSize = 512)
        val back = w.readSectors(startLba = 2048, count = 8, blockSize = 512)
        assertArrayEquals(vol, back)
    }

    @Test
    fun readSectorsSpansMultipleReadCommands() {
        val dev = RecordingDiskDevice(blockSize = 512, capacityBlocks = 8192)
        val w = MassStorageWriter(dev, maxWriteBytes = 1024) // 2 blocks/read
        val vol = ByteArray(8 * 512) { (it % 97).toByte() }
        w.writeSectors(vol, startLba = 100, blockSize = 512)
        val back = w.readSectors(startLba = 100, count = 8, blockSize = 512)
        assertArrayEquals(vol, back)
        // 8 blocks / 2-per-read = 4 READ(10)s at 100, 102, 104, 106.
        assertEquals(listOf(100L to 2, 102L to 2, 104L to 2, 106L to 2), dev.reads)
    }

    @Test
    fun readSectorsReturnsZerosForUnwrittenBlocks() {
        val dev = RecordingDiskDevice(blockSize = 512, capacityBlocks = 4096)
        val back = MassStorageWriter(dev).readSectors(startLba = 10, count = 1, blockSize = 512)
        assertEquals(512, back.size)
        for (b in back) assertEquals(0, b.toInt())
    }
}
