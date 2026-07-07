// Pure-Kotlin GPT reader for the seed-and-append burn
// (docs/iso-seed-and-on-device-burn.md, "option 4" — now the chosen, QEMU-
// validated path). The seed already carries an EMPTY, GPT-registered FLAGSHIP
// FAT16 partition (added at build time via `xorriso -append_partition`), so the
// burner does ZERO partition-table surgery: it streams the seed verbatim, then
// OVERWRITES that pre-declared region with the per-recipe FAT volume.
//
// This locates the region by reading the GPT (off the seed bytes or the
// just-written stick, byte-identical): parse the primary header at LBA 1, walk
// the partition-entry array, and return the entry with the HIGHEST first_lba —
// that is the appended FLAGSHIP region. No CRCs are recomputed; nothing is
// mutated. The old MBR-splice primitive (PartitionTable) is retired: Linux
// ignores MBR entries on a GPT isohybrid, so d-i never saw a slot-3 partition.
//
// GPT LBAs are ALWAYS 512-byte logical sectors (per the UEFI spec), regardless
// of the device's own block size from READ CAPACITY. Byte offsets are computed
// in those 512-byte units; the caller converts to device-block units for the
// WRITE(10). No Android deps — JVM-unit-testable against a synthetic GPT.

package com.flagshipserver.app.burner.iso

object GptReader {
    /** GPT logical-block size is fixed at 512 bytes by the UEFI spec. */
    const val GPT_LBA = 512

    private const val HEADER_LBA = 1L
    private val SIGNATURE = byteArrayOf('E'.code.toByte(), 'F'.code.toByte(), 'I'.code.toByte(), ' '.code.toByte(), 'P'.code.toByte(), 'A'.code.toByte(), 'R'.code.toByte(), 'T'.code.toByte())

    private const val HDR_PART_ENTRIES_LBA = 72
    private const val HDR_ENTRY_COUNT = 80
    private const val HDR_ENTRY_SIZE = 84
    private const val HEADER_MIN_BYTES = 92

    private const val ENTRY_TYPE_GUID = 0
    private const val ENTRY_FIRST_LBA = 32
    private const val ENTRY_LAST_LBA = 40
    private const val ENTRY_MIN_SIZE = 48

    // Sanity bounds so a corrupt/hostile GPT can't drive an unbounded walk.
    private const val MAX_ENTRY_COUNT = 65_536
    private const val MAX_ENTRY_SIZE = 4_096

    /** A byte-addressable, seekable view over the disk (or the seed bytes). */
    fun interface ByteReader {
        /** Return exactly [length] bytes starting at absolute [offset]. */
        fun readAt(offset: Long, length: Int): ByteArray
    }

    /** The FLAGSHIP region on the stick, as raw byte offsets from LBA 0. */
    data class Region(val offsetBytes: Long, val sizeBytes: Long)

    class GptException(message: String) : RuntimeException(message)

    /** Wrap an in-memory disk image as a [ByteReader] (tests + small prefixes). */
    fun fromBytes(bytes: ByteArray): ByteReader = ByteReader { offset, length ->
        if (offset < 0 || length < 0 || offset + length > bytes.size) {
            throw GptException("read out of range (offset=$offset length=$length size=${bytes.size})")
        }
        bytes.copyOfRange(offset.toInt(), (offset + length).toInt())
    }

    /**
     * Find the appended FLAGSHIP partition by reading the GPT via [reader]: the
     * entry with the HIGHEST first_lba. [deviceBlockSize] is the target's own
     * block size (from READ CAPACITY); the returned [Region.offsetBytes] is
     * asserted to be a whole multiple of it so the caller can WRITE(10) there.
     *
     * @throws GptException if the GPT is missing/invalid, has no usable
     *   partition, or the region is not device-block-aligned.
     */
    fun findFlagshipRegion(reader: ByteReader, deviceBlockSize: Int): Region {
        require(deviceBlockSize > 0) { "deviceBlockSize must be > 0" }

        val header = reader.readAt(HEADER_LBA * GPT_LBA, HEADER_MIN_BYTES)
        if (!header.copyOfRange(0, 8).contentEquals(SIGNATURE)) {
            throw GptException("no GPT: missing \"EFI PART\" signature at LBA 1")
        }
        val entriesLba = le64(header, HDR_PART_ENTRIES_LBA)
        val entryCount = le32(header, HDR_ENTRY_COUNT).toInt()
        val entrySize = le32(header, HDR_ENTRY_SIZE).toInt()
        if (entriesLba <= 0) throw GptException("GPT partition-entries LBA is invalid ($entriesLba)")
        if (entryCount !in 1..MAX_ENTRY_COUNT) throw GptException("GPT entry count out of range ($entryCount)")
        if (entrySize !in ENTRY_MIN_SIZE..MAX_ENTRY_SIZE) throw GptException("GPT entry size out of range ($entrySize)")

        val arrayBase = entriesLba * GPT_LBA
        var best: Region? = null
        for (i in 0 until entryCount) {
            val e = reader.readAt(arrayBase + i.toLong() * entrySize, entrySize)
            if (isUnused(e)) continue
            val first = le64(e, ENTRY_FIRST_LBA)
            val last = le64(e, ENTRY_LAST_LBA)
            if (first <= 0 || last < first) continue
            if (best == null || first * GPT_LBA > best!!.offsetBytes) {
                best = Region(offsetBytes = first * GPT_LBA, sizeBytes = (last - first + 1) * GPT_LBA)
            }
        }
        val region = best ?: throw GptException("GPT has no usable partition entry")

        if (region.offsetBytes % deviceBlockSize != 0L) {
            throw GptException(
                "FLAGSHIP region offset ${region.offsetBytes} is not aligned to the device block size $deviceBlockSize",
            )
        }
        return region
    }

    /** An entry is unused when its 16-byte type-GUID (bytes 0..15) is all zero. */
    private fun isUnused(entry: ByteArray): Boolean {
        for (i in ENTRY_TYPE_GUID until ENTRY_TYPE_GUID + 16) if (entry[i].toInt() != 0) return false
        return true
    }

    private fun le32(b: ByteArray, off: Int): Long {
        var v = 0L
        for (i in 0 until 4) v = v or ((b[off + i].toLong() and 0xFF) shl (8 * i))
        return v
    }

    private fun le64(b: ByteArray, off: Int): Long {
        var v = 0L
        for (i in 0 until 8) v = v or ((b[off + i].toLong() and 0xFF) shl (8 * i))
        return v
    }
}
