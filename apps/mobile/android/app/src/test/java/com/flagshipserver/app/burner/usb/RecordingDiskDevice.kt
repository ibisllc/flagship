package com.flagshipserver.app.burner.usb

/**
 * A simulated USB Mass Storage device that speaks the Bulk-Only Transport state
 * machine AND keeps a sparse backing disk, so tests can drive arbitrary-LBA
 * WRITE(10) + READ(10) round-trips and assert the exact sectors touched. The
 * existing MassStorageWriterTest fake is write-only + LBA-0-sequential; this one
 * records every (lba, blockCount) and serves reads from what was written.
 */
class RecordingDiskDevice(
    val blockSize: Int,
    val capacityBlocks: Long,
) : BulkTransport {
    /** lba -> the one-block bytes stored there (unset blocks read back as zeros). */
    val disk = HashMap<Long, ByteArray>()

    /** Every WRITE(10) issued, as (startLba, blockCount), in order. */
    val writes = mutableListOf<Pair<Long, Int>>()

    /** Every READ(10) issued, as (startLba, blockCount), in order. */
    val reads = mutableListOf<Pair<Long, Int>>()

    private var cdb: ByteArray? = null
    private var tag = 0
    private var isIn = false
    private var dataPending = false
    private var response: ByteArray = ByteArray(0)
    private var respPos = 0

    override fun bulkOut(buf: ByteArray, len: Int, timeoutMs: Int): Int {
        if (cdb == null) {
            require(len == ScsiCommands.CBW_LENGTH) { "expected 31-byte CBW, got $len" }
            require(ScsiCommands.getLeU32(buf, 0) == ScsiCommands.CBW_SIGNATURE) { "bad CBW signature" }
            tag = ScsiCommands.getLeU32(buf, 4)
            val dataLen = ScsiCommands.getLeU32(buf, 8)
            isIn = (buf[12].toInt() and 0xFF) == ScsiCommands.FLAG_DATA_IN
            val cdbLen = buf[14].toInt() and 0xFF
            cdb = buf.copyOfRange(15, 15 + cdbLen)
            dataPending = dataLen > 0
            if (isIn && dataPending) {
                response = responseFor(cdb!!)
                respPos = 0
            }
            return ScsiCommands.CBW_LENGTH
        }
        // OUT data phase for WRITE(10).
        val c = cdb!!
        require((c[0].toInt() and 0xFF) == ScsiCommands.OP_WRITE_10) { "unexpected OUT data phase" }
        val lba = ScsiCommands.getBeU32(c, 2)
        val blocks = ((c[7].toInt() and 0xFF) shl 8) or (c[8].toInt() and 0xFF)
        require(len == blocks * blockSize) { "data-out length $len != ${blocks * blockSize}" }
        writes.add(lba to blocks)
        for (i in 0 until blocks) {
            disk[lba + i] = buf.copyOfRange(i * blockSize, (i + 1) * blockSize)
        }
        dataPending = false
        return len
    }

    override fun bulkIn(buf: ByteArray, len: Int, timeoutMs: Int): Int {
        if (dataPending && isIn) {
            val n = minOf(len, response.size - respPos)
            System.arraycopy(response, respPos, buf, 0, n)
            respPos += n
            if (respPos >= response.size) dataPending = false
            return n
        }
        ScsiCommands.putLeU32(buf, 0, ScsiCommands.CSW_SIGNATURE)
        ScsiCommands.putLeU32(buf, 4, tag)
        ScsiCommands.putLeU32(buf, 8, 0)
        buf[12] = ScsiCommands.CSW_PASSED.toByte()
        cdb = null
        return ScsiCommands.CSW_LENGTH
    }

    private fun responseFor(c: ByteArray): ByteArray = when (c[0].toInt() and 0xFF) {
        ScsiCommands.OP_READ_CAPACITY_10 -> ByteArray(8).also {
            ScsiCommands.putBeU32(it, 0, capacityBlocks - 1)
            ScsiCommands.putBeU32(it, 4, blockSize.toLong())
        }
        ScsiCommands.OP_READ_10 -> {
            val lba = ScsiCommands.getBeU32(c, 2)
            val blocks = ((c[7].toInt() and 0xFF) shl 8) or (c[8].toInt() and 0xFF)
            reads.add(lba to blocks)
            ByteArray(blocks * blockSize).also { out ->
                for (i in 0 until blocks) disk[lba + i]?.copyInto(out, i * blockSize)
            }
        }
        else -> ByteArray(0)
    }
}
