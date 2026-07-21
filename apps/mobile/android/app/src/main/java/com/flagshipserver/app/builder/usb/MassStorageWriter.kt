// Drives the USB Mass Storage Bulk-Only Transport (BOT) protocol over a pair
// of bulk endpoints to raw-write a USB stick — no root, no block device.
//
// The transport is abstracted behind [BulkTransport] so the whole protocol
// (CBW → optional data phase → CSW, command sequencing, the write loop) is
// unit-testable against a simulated device with no hardware. The real Android
// impl ([UsbBulkTransport] in UsbHost.kt) wraps UsbDeviceConnection.bulkTransfer.

package com.flagshipserver.app.builder.usb

import java.io.InputStream
import java.util.concurrent.atomic.AtomicInteger

/** A bidirectional bulk pipe to one USB mass-storage LUN. */
interface BulkTransport {
    /** Send [len] bytes of [buf] on the OUT endpoint. Returns bytes sent, or <0 on error. */
    fun bulkOut(buf: ByteArray, len: Int, timeoutMs: Int): Int

    /** Receive up to [len] bytes into [buf] on the IN endpoint. Returns bytes read, or <0. */
    fun bulkIn(buf: ByteArray, len: Int, timeoutMs: Int): Int
}

class MassStorageException(message: String) : RuntimeException(message)

/**
 * @param transport      the bulk pipe.
 * @param lun            logical unit (almost always 0).
 * @param maxWriteBytes  bytes per WRITE(10) command. 32 KiB is a safe default
 *                       that divides both 512 and 2048 (ISO) sector sizes and
 *                       stays within conservative bulkTransfer limits. Tunable
 *                       after on-hardware profiling.
 */
class MassStorageWriter(
    private val transport: BulkTransport,
    private val lun: Int = 0,
    private val maxWriteBytes: Int = 32 * 1024,
    private val timeoutMs: Int = 30_000,
) {
    private val tagCounter = AtomicInteger(0x4653_0000.toInt()) // "FS" prefix, arbitrary

    private fun nextTag(): Int = tagCounter.incrementAndGet()

    /**
     * Run one BOT command: send the CBW, run the data phase (in or out), read
     * + validate the CSW. Returns the number of data bytes actually transferred
     * in the data phase. Throws [MassStorageException] on any wire/status error.
     */
    private fun transact(
        cdb: ByteArray,
        dataIn: ByteArray?,
        dataInLen: Int,
        dataOut: ByteArray?,
        dataOutLen: Int,
    ): Int {
        require(!(dataIn != null && dataOut != null)) { "a command has at most one data direction" }
        val isIn = dataIn != null
        val dataLen = if (isIn) dataInLen else dataOutLen
        val tag = nextTag()
        val cbw = ScsiCommands.buildCbw(tag, dataLen, isIn, lun, cdb)

        val sent = transport.bulkOut(cbw, cbw.size, timeoutMs)
        if (sent != ScsiCommands.CBW_LENGTH) {
            throw MassStorageException("CBW send failed (sent=$sent, op=0x${(cdb[0].toInt() and 0xFF).toString(16)})")
        }

        var transferred = 0
        if (dataLen > 0) {
            transferred = if (isIn) {
                val n = transport.bulkIn(dataIn!!, dataInLen, timeoutMs)
                if (n < 0) throw MassStorageException("data-in failed (n=$n)")
                n
            } else {
                val n = transport.bulkOut(dataOut!!, dataOutLen, timeoutMs)
                if (n < 0) throw MassStorageException("data-out failed (n=$n)")
                n
            }
        }

        val cswBuf = ByteArray(ScsiCommands.CSW_LENGTH)
        val cswN = transport.bulkIn(cswBuf, cswBuf.size, timeoutMs)
        if (cswN < ScsiCommands.CSW_LENGTH) {
            throw MassStorageException("CSW read short (n=$cswN)")
        }
        val csw = ScsiCommands.parseCsw(cswBuf)
        if (!csw.signatureValid) throw MassStorageException("bad CSW signature 0x${csw.signature.toString(16)}")
        if (csw.tag != tag) throw MassStorageException("CSW tag mismatch (sent=$tag got=${csw.tag})")
        if (!csw.passed) throw MassStorageException("SCSI command failed (status=${csw.status}, op=0x${(cdb[0].toInt() and 0xFF).toString(16)})")
        return transferred
    }

    /** TEST UNIT READY — true if the LUN is ready (no exception thrown). */
    fun testUnitReady(): Boolean {
        return try {
            transact(ScsiCommands.cdbTestUnitReady(), null, 0, null, 0)
            true
        } catch (_: MassStorageException) {
            false
        }
    }

    /** Standard INQUIRY → the vendor/product strings (best-effort). */
    data class Inquiry(val vendor: String, val product: String, val raw: ByteArray)

    fun inquiry(): Inquiry {
        val data = ByteArray(36)
        val n = transact(ScsiCommands.cdbInquiry(36), data, 36, null, 0)
        val vendor = if (n >= 16) String(data, 8, 8, Charsets.US_ASCII).trim() else ""
        val product = if (n >= 32) String(data, 16, 16, Charsets.US_ASCII).trim() else ""
        return Inquiry(vendor, product, data.copyOf(maxOf(n, 0)))
    }

    /** READ CAPACITY(10) → block size + count. */
    fun readCapacity(): ScsiCommands.Capacity {
        val data = ByteArray(8)
        val n = transact(ScsiCommands.cdbReadCapacity10(), data, 8, null, 0)
        if (n < 8) throw MassStorageException("READ CAPACITY returned $n bytes")
        return ScsiCommands.parseCapacity10(data)
    }

    /**
     * Stream [source] ([totalBytes] long) to the device starting at LBA 0,
     * issuing WRITE(10) commands of at most [maxWriteBytes]. The final partial
     * block is zero-padded to a whole block (USB MSC is block-addressed).
     * [onProgress] is called with cumulative SOURCE bytes written (not padding).
     *
     * @return total source bytes written.
     */
    fun writeImage(
        source: InputStream,
        totalBytes: Long,
        blockSize: Int,
        onProgress: (written: Long) -> Unit = {},
    ): Long {
        require(blockSize > 0) { "blockSize must be > 0" }
        require(maxWriteBytes % blockSize == 0) {
            "maxWriteBytes ($maxWriteBytes) must be a multiple of blockSize ($blockSize)"
        }
        val blocksPerWrite = maxWriteBytes / blockSize
        val chunk = ByteArray(maxWriteBytes)
        var lba = 0L
        var written = 0L

        while (written < totalBytes) {
            // Fill a chunk from the stream (may stop short at EOF).
            var filled = 0
            while (filled < chunk.size && written + filled < totalBytes) {
                val r = source.read(chunk, filled, chunk.size - filled)
                if (r < 0) break
                filled += r
            }
            if (filled == 0) break

            // Zero-pad the tail to a whole block.
            val blocks = (filled + blockSize - 1) / blockSize
            val padded = blocks * blockSize
            if (padded > filled) java.util.Arrays.fill(chunk, filled, padded, 0)

            require(blocks <= blocksPerWrite) { "internal: chunk exceeds blocksPerWrite" }
            transact(
                ScsiCommands.cdbWrite10(lba, blocks),
                dataIn = null, dataInLen = 0,
                dataOut = chunk, dataOutLen = padded,
            )
            lba += blocks
            written += filled
            onProgress(written)
        }
        return written
    }
}
