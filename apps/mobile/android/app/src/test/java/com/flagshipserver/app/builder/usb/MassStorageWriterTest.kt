package com.flagshipserver.app.builder.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/**
 * Drives [MassStorageWriter] against a simulated USB Mass Storage device that
 * speaks the Bulk-Only Transport state machine (CBW → data phase → CSW). This
 * exercises the full command sequencing + the write loop with no hardware: the
 * device records what it was told to write and we assert it round-trips the
 * source bytes exactly (including the zero-padded final block).
 */
private class FakeDevice(
    val blockSize: Int,
    val capacityBlocks: Long,
    /** Force a failed CSW status on the Nth WRITE (1-based) to test error paths. */
    val failWriteAt: Int = -1,
) : BulkTransport {
    val written = ByteArrayOutputStream()
    var nextExpectedLba = 0L
    private var writeCount = 0

    private var cmdCdb: ByteArray? = null
    private var cmdTag = 0
    private var cmdIsIn = false
    private var dataDone = false
    private var response: ByteArray? = null
    private var forceFailStatus = false

    override fun bulkOut(buf: ByteArray, len: Int, timeoutMs: Int): Int {
        if (cmdCdb == null) {
            // This is a CBW.
            require(len == ScsiCommands.CBW_LENGTH) { "expected 31-byte CBW, got $len" }
            require(ScsiCommands.getLeU32(buf, 0) == ScsiCommands.CBW_SIGNATURE) { "bad CBW signature" }
            cmdTag = ScsiCommands.getLeU32(buf, 4)
            val dataLen = ScsiCommands.getLeU32(buf, 8)
            cmdIsIn = (buf[12].toInt() and 0xFF) == ScsiCommands.FLAG_DATA_IN
            val cdbLen = buf[14].toInt() and 0xFF
            cmdCdb = buf.copyOfRange(15, 15 + cdbLen)
            dataDone = dataLen == 0
            forceFailStatus = false
            response = if (cmdIsIn) responseFor(cmdCdb!!) else null
            return ScsiCommands.CBW_LENGTH
        }
        // OUT data phase for WRITE(10).
        val cdb = cmdCdb!!
        require((cdb[0].toInt() and 0xFF) == ScsiCommands.OP_WRITE_10)
        val lba = ScsiCommands.getBeU32(cdb, 2)
        require(lba == nextExpectedLba) { "non-sequential write: expected $nextExpectedLba got $lba" }
        val blocks = ((cdb[7].toInt() and 0xFF) shl 8) or (cdb[8].toInt() and 0xFF)
        require(len == blocks * blockSize) { "data-out length $len != blocks*blockSize ${blocks * blockSize}" }
        written.write(buf, 0, len)
        nextExpectedLba += blocks
        writeCount++
        if (writeCount == failWriteAt) forceFailStatus = true
        dataDone = true
        return len
    }

    override fun bulkIn(buf: ByteArray, len: Int, timeoutMs: Int): Int {
        val cdb = cmdCdb ?: error("bulkIn with no command pending")
        if (cmdIsIn && !dataDone) {
            val r = response ?: ByteArray(0)
            val n = minOf(len, r.size)
            System.arraycopy(r, 0, buf, 0, n)
            dataDone = true
            return n
        }
        // CSW phase.
        ScsiCommands.putLeU32(buf, 0, ScsiCommands.CSW_SIGNATURE)
        ScsiCommands.putLeU32(buf, 4, cmdTag)
        ScsiCommands.putLeU32(buf, 8, 0)
        buf[12] = (if (forceFailStatus) ScsiCommands.CSW_FAILED else ScsiCommands.CSW_PASSED).toByte()
        cmdCdb = null
        return ScsiCommands.CSW_LENGTH
    }

    private fun responseFor(cdb: ByteArray): ByteArray = when (cdb[0].toInt() and 0xFF) {
        ScsiCommands.OP_INQUIRY -> ByteArray(36).also {
            // bytes 8..15 vendor, 16..31 product
            "ACME    ".toByteArray(Charsets.US_ASCII).copyInto(it, 8)
            "FlagDrive       ".toByteArray(Charsets.US_ASCII).copyInto(it, 16)
        }
        ScsiCommands.OP_READ_CAPACITY_10 -> ByteArray(8).also {
            ScsiCommands.putBeU32(it, 0, capacityBlocks - 1) // last LBA
            ScsiCommands.putBeU32(it, 4, blockSize.toLong())
        }
        else -> ByteArray(0)
    }
}

class MassStorageWriterTest {
    @Test
    fun inquiryReadsVendorAndProduct() {
        val dev = FakeDevice(blockSize = 512, capacityBlocks = 1000)
        val w = MassStorageWriter(dev)
        val inq = w.inquiry()
        assertEquals("ACME", inq.vendor)
        assertEquals("FlagDrive", inq.product)
    }

    @Test
    fun readCapacityReportsGeometry() {
        val dev = FakeDevice(blockSize = 512, capacityBlocks = 2048)
        val cap = MassStorageWriter(dev).readCapacity()
        assertEquals(512, cap.blockSize)
        assertEquals(2048L, cap.blockCount)
        assertEquals(2048L * 512, cap.totalBytes)
    }

    @Test
    fun writeImageRoundTripsExactBytesWithBlockPadding() {
        val blockSize = 512
        val dev = FakeDevice(blockSize = blockSize, capacityBlocks = 4096)
        // 5000 bytes — NOT a multiple of 512, so the last block is zero-padded.
        val source = ByteArray(5000) { (it % 251).toByte() }
        val w = MassStorageWriter(dev, maxWriteBytes = 2048) // 4 blocks/write
        var lastProgress = 0L
        val written = w.writeImage(
            ByteArrayInputStream(source), source.size.toLong(), blockSize,
        ) { lastProgress = it }
        assertEquals(source.size.toLong(), written)
        assertEquals(source.size.toLong(), lastProgress)

        val deviceBytes = dev.written.toByteArray()
        // Padded up to a whole block: ceil(5000/512)=10 blocks = 5120 bytes.
        assertEquals(5120, deviceBytes.size)
        // The first 5000 bytes equal the source.
        assertArrayEquals(source, deviceBytes.copyOfRange(0, 5000))
        // The tail is zero padding.
        for (i in 5000 until 5120) assertEquals(0, deviceBytes[i].toInt())
    }

    @Test
    fun writeImageExactBlockMultipleHasNoPadding() {
        val dev = FakeDevice(blockSize = 512, capacityBlocks = 4096)
        val source = ByteArray(2048) { (it and 0xFF).toByte() }
        val w = MassStorageWriter(dev, maxWriteBytes = 1024)
        w.writeImage(ByteArrayInputStream(source), source.size.toLong(), 512)
        assertArrayEquals(source, dev.written.toByteArray())
    }

    @Test
    fun progressIsMonotonicAndReachesTotal() {
        val dev = FakeDevice(blockSize = 512, capacityBlocks = 8192)
        val source = ByteArray(10_000)
        val seen = mutableListOf<Long>()
        MassStorageWriter(dev, maxWriteBytes = 2048)
            .writeImage(ByteArrayInputStream(source), source.size.toLong(), 512) { seen.add(it) }
        assertTrue(seen.isNotEmpty())
        for (i in 1 until seen.size) assertTrue(seen[i] >= seen[i - 1])
        assertEquals(10_000L, seen.last())
    }

    @Test
    fun failedCswStatusThrows() {
        val dev = FakeDevice(blockSize = 512, capacityBlocks = 4096, failWriteAt = 2)
        val source = ByteArray(4096)
        val w = MassStorageWriter(dev, maxWriteBytes = 1024) // 2 blocks/write → many writes
        assertThrows(MassStorageException::class.java) {
            w.writeImage(ByteArrayInputStream(source), source.size.toLong(), 512)
        }
    }

    @Test
    fun maxWriteBytesMustBeBlockMultiple() {
        val dev = FakeDevice(blockSize = 512, capacityBlocks = 100)
        val w = MassStorageWriter(dev, maxWriteBytes = 1000) // not a multiple of 512
        assertThrows(IllegalArgumentException::class.java) {
            w.writeImage(ByteArrayInputStream(ByteArray(10)), 10, 512)
        }
    }
}
