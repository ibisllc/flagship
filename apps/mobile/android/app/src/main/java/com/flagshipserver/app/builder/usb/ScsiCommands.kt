// USB Mass Storage — Bulk-Only Transport (BOT) wire encoders.
//
// Pure byte builders/parsers for the BOT wrappers (CBW/CSW) and the SCSI
// command descriptor blocks (CDBs) the on-device builder needs to raw-write a
// USB stick with no root and no block device — just the bulk endpoints.
//
// TWO ENDIANNESSES, deliberately different (a classic source of bugs, so the
// unit tests pin both):
//   * BOT wrapper fields (dCBWSignature, dCBWTag, dCBWDataTransferLength,
//     dCSW* …) are LITTLE-ENDIAN.
//   * SCSI CDB multi-byte fields (LBA, transfer length, allocation length …)
//     and the data returned by READ CAPACITY are BIG-ENDIAN.
//
// Spec: USB Mass Storage Class — Bulk-Only Transport (rev 1.0) + SCSI SBC/SPC.

package com.flagshipserver.app.builder.usb

object ScsiCommands {
    // ── BOT signatures ─────────────────────────────────────────────
    /** dCBWSignature — "USBC" as a little-endian u32 (0x43425355). */
    const val CBW_SIGNATURE: Int = 0x43425355
    /** dCSWSignature — "USBS" as a little-endian u32 (0x53425355). */
    const val CSW_SIGNATURE: Int = 0x53425355

    const val CBW_LENGTH = 31
    const val CSW_LENGTH = 13

    /** bmCBWFlags direction bits. */
    const val FLAG_DATA_IN: Int = 0x80 // device → host (reads)
    const val FLAG_DATA_OUT: Int = 0x00 // host → device (writes)

    /** bCSWStatus values. */
    const val CSW_PASSED = 0
    const val CSW_FAILED = 1
    const val CSW_PHASE_ERROR = 2

    // ── SCSI opcodes ───────────────────────────────────────────────
    const val OP_TEST_UNIT_READY = 0x00
    const val OP_INQUIRY = 0x12
    const val OP_READ_CAPACITY_10 = 0x25
    const val OP_READ_10 = 0x28
    const val OP_WRITE_10 = 0x2A

    /**
     * Build a 31-byte Command Block Wrapper.
     *
     * @param tag         host-chosen u32 echoed back in the CSW.
     * @param dataLength  bytes of the data phase (0 if none).
     * @param flagsIn     true for a device→host data phase (reads), false for OUT.
     * @param lun         logical unit number (low 4 bits used).
     * @param cdb         the SCSI CDB (1..16 bytes); copied into CBWCB[16].
     */
    fun buildCbw(
        tag: Int,
        dataLength: Int,
        flagsIn: Boolean,
        lun: Int,
        cdb: ByteArray,
    ): ByteArray {
        require(cdb.isNotEmpty() && cdb.size <= 16) { "CDB must be 1..16 bytes, got ${cdb.size}" }
        require(dataLength >= 0) { "dataLength must be >= 0" }
        val b = ByteArray(CBW_LENGTH)
        putLeU32(b, 0, CBW_SIGNATURE)
        putLeU32(b, 4, tag)
        putLeU32(b, 8, dataLength)
        b[12] = (if (flagsIn) FLAG_DATA_IN else FLAG_DATA_OUT).toByte()
        b[13] = (lun and 0x0F).toByte()
        b[14] = cdb.size.toByte()
        System.arraycopy(cdb, 0, b, 15, cdb.size)
        return b
    }

    /** A parsed Command Status Wrapper. */
    data class Csw(val signature: Int, val tag: Int, val dataResidue: Int, val status: Int) {
        val passed: Boolean get() = status == CSW_PASSED
        val signatureValid: Boolean get() = signature == CSW_SIGNATURE
    }

    /** Parse a 13-byte CSW. Throws if the buffer is too short. */
    fun parseCsw(b: ByteArray, len: Int = b.size): Csw {
        require(len >= CSW_LENGTH) { "CSW must be >= $CSW_LENGTH bytes, got $len" }
        return Csw(
            signature = getLeU32(b, 0),
            tag = getLeU32(b, 4),
            dataResidue = getLeU32(b, 8),
            status = b[12].toInt() and 0xFF,
        )
    }

    // ── CDB builders ───────────────────────────────────────────────

    /** TEST UNIT READY (6-byte CDB, all zero except opcode). */
    fun cdbTestUnitReady(): ByteArray = ByteArray(6).also { it[0] = OP_TEST_UNIT_READY.toByte() }

    /** Standard INQUIRY (6-byte CDB). allocLength is BIG-ENDIAN at bytes 3..4. */
    fun cdbInquiry(allocLength: Int = 36): ByteArray {
        require(allocLength in 0..0xFFFF) { "allocLength out of range" }
        val c = ByteArray(6)
        c[0] = OP_INQUIRY.toByte()
        c[3] = ((allocLength ushr 8) and 0xFF).toByte()
        c[4] = (allocLength and 0xFF).toByte()
        return c
    }

    /** READ CAPACITY(10) (10-byte CDB). Returns 8 data bytes: lastLBA + blockSize, both BE. */
    fun cdbReadCapacity10(): ByteArray = ByteArray(10).also { it[0] = OP_READ_CAPACITY_10.toByte() }

    /**
     * WRITE(10) (10-byte CDB). LBA is BIG-ENDIAN u32 at bytes 2..5; transfer
     * length (in BLOCKS) is BIG-ENDIAN u16 at bytes 7..8.
     */
    fun cdbWrite10(lba: Long, blocks: Int): ByteArray {
        require(lba in 0..0xFFFFFFFFL) { "LBA out of 32-bit range" }
        require(blocks in 0..0xFFFF) { "transfer length out of 16-bit range" }
        val c = ByteArray(10)
        c[0] = OP_WRITE_10.toByte()
        putBeU32(c, 2, lba)
        c[7] = ((blocks ushr 8) and 0xFF).toByte()
        c[8] = (blocks and 0xFF).toByte()
        return c
    }

    /** READ(10) (10-byte CDB). Same field layout as WRITE(10). */
    fun cdbRead10(lba: Long, blocks: Int): ByteArray =
        cdbWrite10(lba, blocks).also { it[0] = OP_READ_10.toByte() }

    /** Parse the 8-byte READ CAPACITY(10) data: (lastLba, blockSizeBytes), both BE. */
    data class Capacity(val lastLba: Long, val blockSize: Int) {
        /** Total addressable blocks = lastLBA + 1. */
        val blockCount: Long get() = lastLba + 1
        val totalBytes: Long get() = blockCount * blockSize
    }

    fun parseCapacity10(b: ByteArray, len: Int = b.size): Capacity {
        require(len >= 8) { "READ CAPACITY(10) data must be 8 bytes, got $len" }
        return Capacity(lastLba = getBeU32(b, 0), blockSize = getBeU32(b, 4).toInt())
    }

    // ── Endianness helpers (kept package-visible for tests) ────────

    fun putLeU32(b: ByteArray, off: Int, v: Int) {
        b[off] = (v and 0xFF).toByte()
        b[off + 1] = ((v ushr 8) and 0xFF).toByte()
        b[off + 2] = ((v ushr 16) and 0xFF).toByte()
        b[off + 3] = ((v ushr 24) and 0xFF).toByte()
    }

    fun getLeU32(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xFF) or
            ((b[off + 1].toInt() and 0xFF) shl 8) or
            ((b[off + 2].toInt() and 0xFF) shl 16) or
            ((b[off + 3].toInt() and 0xFF) shl 24)

    fun putBeU32(b: ByteArray, off: Int, v: Long) {
        b[off] = ((v ushr 24) and 0xFF).toByte()
        b[off + 1] = ((v ushr 16) and 0xFF).toByte()
        b[off + 2] = ((v ushr 8) and 0xFF).toByte()
        b[off + 3] = (v and 0xFF).toByte()
    }

    /** Read a big-endian u32 as a non-negative Long. */
    fun getBeU32(b: ByteArray, off: Int): Long =
        ((b[off].toLong() and 0xFF) shl 24) or
            ((b[off + 1].toLong() and 0xFF) shl 16) or
            ((b[off + 2].toLong() and 0xFF) shl 8) or
            (b[off + 3].toLong() and 0xFF)
}
