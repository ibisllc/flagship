// Pure-Kotlin MBR partition arithmetic for the seed-and-append burn
// (docs/iso-seed-and-on-device-burn.md): after the seed ISO is streamed to the
// stick verbatim from LBA 0, the FLAGSHIP FAT16 volume is placed in free space
// past the ISO image and one MBR partition entry is spliced in so the installer
// can find it. This computes that placement + entry and patches LBA 0, with no
// Android deps (JVM-unit-testable). Raw sector I/O lives in MassStorageWriter.
//
// ⚠️ NOT SUFFICIENT ALONE ON THE SHIPPING SEED. The Debian seed is a GPT
// isohybrid, and Linux IGNORES MBR partition entries on a GPT disk — so d-i's
// `list-devices partition` will NOT see a FLAGSHIP partition that exists only
// in the MBR. Verified on a build host (docs "Partition registration" §). This
// MBR splice is the correct, tested primitive for an MBR-authoritative disk;
// before a real burn boots, ONE of these must also happen (see the doc, all
// hardware-gated / task #19): register FLAGSHIP in the GPT, or build the seed
// MBR-only, or pre-declare the partition in the GPT at seed-build time. Do not
// treat MBR-only as done.

package com.flagshipserver.app.burner.iso

object PartitionTable {
    const val MBR_SIZE = 512
    const val TABLE_OFFSET = 446
    const val ENTRY_SIZE = 16
    const val SLOT_COUNT = 4

    /** Partition type 0x0e = FAT16 with LBA addressing (the FLAGSHIP volume is FAT16). */
    const val TYPE_FAT16_LBA = 0x0e

    private const val MB = 1024L * 1024L

    /** Where the FLAGSHIP volume lands on the stick, in the device's own blocks. */
    data class Placement(val startLba: Long, val sectorCount: Long)

    class PlacementException(message: String) : RuntimeException(message)

    /**
     * Compute where to place the FLAGSHIP FAT volume: aligned to a 1 MB boundary
     * past the seed image, sized to hold [fatVolumeBytes], fitting before
     * [lastLba] (inclusive — the last addressable block from READ CAPACITY).
     *
     * @throws PlacementException if the volume would not fit on the stick.
     */
    fun placeFatVolume(
        seedImageBytes: Long,
        fatVolumeBytes: Int,
        blockSize: Int,
        lastLba: Long,
    ): Placement {
        require(seedImageBytes >= 0) { "seedImageBytes must be >= 0" }
        require(fatVolumeBytes > 0) { "fatVolumeBytes must be > 0" }
        require(blockSize > 0) { "blockSize must be > 0" }
        require(MB % blockSize == 0L) { "blockSize ($blockSize) must divide 1 MB" }

        val startByte = ceilTo(seedImageBytes, MB)
        val startLba = startByte / blockSize
        val sectorCount = ceilDiv(fatVolumeBytes.toLong(), blockSize.toLong())
        val endLba = startLba + sectorCount - 1
        if (endLba > lastLba) {
            throw PlacementException(
                "FLAGSHIP volume (${fatVolumeBytes} B at LBA $startLba, $sectorCount blocks) " +
                    "runs past the drive's last block ($lastLba)",
            )
        }
        return Placement(startLba, sectorCount)
    }

    /**
     * The 16-byte MBR partition entry for [placement] of the given [type].
     * Non-bootable (boot flag 0x00); CHS fields are zeroed — LBA is authoritative
     * and every UEFI/BIOS that boots the isohybrid seed honours LBA addressing.
     * LBA-start (bytes 8..11) and sector-count (bytes 12..15) are little-endian.
     */
    fun partitionEntry(placement: Placement, type: Int = TYPE_FAT16_LBA): ByteArray {
        require(type in 0..0xFF) { "partition type out of range" }
        require(placement.startLba in 0..0xFFFFFFFFL) { "startLba out of 32-bit range" }
        require(placement.sectorCount in 1..0xFFFFFFFFL) { "sectorCount out of 32-bit range" }
        val e = ByteArray(ENTRY_SIZE)
        e[0] = 0x00 // boot flag: not active
        // e[1..3] CHS start = 0 (LBA-only)
        e[4] = type.toByte()
        // e[5..7] CHS end = 0 (LBA-only)
        le32(e, 8, placement.startLba)
        le32(e, 12, placement.sectorCount)
        return e
    }

    /**
     * Return a copy of [mbr] (exactly 512 bytes) with [entry] written into
     * partition slot [slotIndex] (0-based; slots live at 446 + i*16). Every other
     * byte — the boot code / disk signature, the other three slots, and the
     * 0x55AA boot signature — is preserved verbatim.
     */
    fun spliceEntry(mbr: ByteArray, slotIndex: Int, entry: ByteArray): ByteArray {
        require(mbr.size == MBR_SIZE) { "MBR must be $MBR_SIZE bytes, got ${mbr.size}" }
        require(entry.size == ENTRY_SIZE) { "entry must be $ENTRY_SIZE bytes, got ${entry.size}" }
        require(slotIndex in 0 until SLOT_COUNT) { "slotIndex must be 0..${SLOT_COUNT - 1}" }
        require((mbr[510].toInt() and 0xFF) == 0x55 && (mbr[511].toInt() and 0xFF) == 0xAA) {
            "MBR is missing the 0x55AA boot signature — not a valid partition sector"
        }
        val out = mbr.copyOf()
        System.arraycopy(entry, 0, out, TABLE_OFFSET + slotIndex * ENTRY_SIZE, ENTRY_SIZE)
        return out
    }

    private fun le32(b: ByteArray, off: Int, v: Long) {
        b[off] = (v and 0xFF).toByte()
        b[off + 1] = ((v ushr 8) and 0xFF).toByte()
        b[off + 2] = ((v ushr 16) and 0xFF).toByte()
        b[off + 3] = ((v ushr 24) and 0xFF).toByte()
    }

    private fun ceilDiv(a: Long, b: Long): Long = (a + b - 1) / b
    private fun ceilTo(v: Long, unit: Long): Long = ceilDiv(v, unit) * unit
}
