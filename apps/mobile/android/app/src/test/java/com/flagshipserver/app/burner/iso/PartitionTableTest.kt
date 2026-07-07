package com.flagshipserver.app.burner.iso

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Pins the MBR partition arithmetic for the seed-and-append burn: the 16-byte
 * entry byte layout, MB-aligned placement past the seed image, the "doesn't fit"
 * rejection, and that splicing a slot preserves the rest of the boot sector.
 */
class PartitionTableTest {
    private fun le32(b: ByteArray, off: Int): Long {
        var v = 0L
        for (i in 0 until 4) v = v or ((b[off + i].toLong() and 0xFF) shl (8 * i))
        return v
    }

    @Test
    fun partitionEntryHasExactByteLayout() {
        val e = PartitionTable.partitionEntry(
            PartitionTable.Placement(startLba = 2048, sectorCount = 8192),
            PartitionTable.TYPE_FAT16_LBA,
        )
        assertEquals(16, e.size)
        assertEquals(0x00, e[0].toInt() and 0xFF) // not bootable
        for (i in 1..3) assertEquals("CHS start byte $i", 0, e[i].toInt()) // CHS zeroed
        assertEquals(0x0e, e[4].toInt() and 0xFF) // FAT16 LBA
        for (i in 5..7) assertEquals("CHS end byte $i", 0, e[i].toInt())
        assertEquals(2048L, le32(e, 8)) // LBA start, little-endian
        assertEquals(8192L, le32(e, 12)) // sector count, little-endian
    }

    @Test
    fun placementAlignsToOneMbPastTheSeed() {
        // Seed sits between 1 MB and 2 MB ⇒ volume starts at the 2 MB boundary.
        val p = PartitionTable.placeFatVolume(
            seedImageBytes = 1_500_000,
            fatVolumeBytes = 2_100_000,
            blockSize = 512,
            lastLba = 1_000_000,
        )
        assertEquals(2L * 1024 * 1024 / 512, p.startLba) // 4096
        assertEquals(0L, p.startLba * 512 % (1024 * 1024)) // MB-aligned
        assertEquals(4102L, p.sectorCount) // ceil(2_100_000 / 512)
    }

    @Test
    fun placementIsIdentityWhenSeedIsExactlyOnAMbBoundary() {
        val p = PartitionTable.placeFatVolume(
            seedImageBytes = 1024L * 1024, // exactly 1 MB
            fatVolumeBytes = 65_536,
            blockSize = 512,
            lastLba = 100_000,
        )
        assertEquals(2048L, p.startLba) // 1 MB / 512, no extra alignment bump
    }

    @Test
    fun placementRejectsAVolumeThatRunsPastTheDrive() {
        // endLba = 4096 + 4102 - 1 = 8197; lastLba one short ⇒ reject.
        val ex = assertThrows(PartitionTable.PlacementException::class.java) {
            PartitionTable.placeFatVolume(
                seedImageBytes = 1_500_000,
                fatVolumeBytes = 2_100_000,
                blockSize = 512,
                lastLba = 8196,
            )
        }
        assertEquals(true, ex.message!!.contains("past the drive"))
    }

    @Test
    fun placementFitsExactlyAtLastLba() {
        val p = PartitionTable.placeFatVolume(
            seedImageBytes = 1_500_000,
            fatVolumeBytes = 2_100_000,
            blockSize = 512,
            lastLba = 8197, // endLba == lastLba ⇒ fits
        )
        assertEquals(8197L, p.startLba + p.sectorCount - 1)
    }

    @Test
    fun spliceEntryReplacesOnlyTheTargetSlot() {
        val mbr = sampleMbr()
        val entry = PartitionTable.partitionEntry(PartitionTable.Placement(4096, 4102))
        val out = PartitionTable.spliceEntry(mbr, slotIndex = 3, entry = entry)

        // Slot 3 now holds the entry.
        assertArrayEquals(entry, out.copyOfRange(446 + 3 * 16, 446 + 4 * 16))
        // Slots 0..2 unchanged.
        assertArrayEquals(mbr.copyOfRange(446, 446 + 3 * 16), out.copyOfRange(446, 446 + 3 * 16))
        // Boot code + disk signature (bytes 0..445) unchanged.
        assertArrayEquals(mbr.copyOfRange(0, 446), out.copyOfRange(0, 446))
        // 0x55AA boot signature preserved.
        assertEquals(0x55, out[510].toInt() and 0xFF)
        assertEquals(0xAA, out[511].toInt() and 0xFF)
        // Input not mutated.
        assertEquals(0, mbr[446 + 3 * 16 + 4].toInt())
    }

    @Test
    fun spliceEntryIntoSlotZeroPreservesOtherSlots() {
        val mbr = sampleMbr()
        val entry = PartitionTable.partitionEntry(PartitionTable.Placement(1, 2))
        val out = PartitionTable.spliceEntry(mbr, slotIndex = 0, entry = entry)
        assertArrayEquals(entry, out.copyOfRange(446, 446 + 16))
        assertArrayEquals(mbr.copyOfRange(446 + 16, 512), out.copyOfRange(446 + 16, 512))
    }

    @Test
    fun spliceRejectsWrongSizeAndMissingSignature() {
        val entry = PartitionTable.partitionEntry(PartitionTable.Placement(1, 2))
        assertThrows(IllegalArgumentException::class.java) {
            PartitionTable.spliceEntry(ByteArray(511), 3, entry)
        }
        val noSig = sampleMbr().also { it[510] = 0; it[511] = 0 }
        assertThrows(IllegalArgumentException::class.java) {
            PartitionTable.spliceEntry(noSig, 3, entry)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PartitionTable.spliceEntry(sampleMbr(), 4, entry)
        }
    }

    /** An isohybrid-like MBR: recognizable boot code, disk signature, one pre-existing partition, 0x55AA. */
    private fun sampleMbr(): ByteArray {
        val mbr = ByteArray(512)
        for (i in 0 until 440) mbr[i] = ((i * 7) and 0xFF).toByte() // boot code
        // Disk signature at 440..443.
        mbr[440] = 0xDE.toByte(); mbr[441] = 0xAD.toByte(); mbr[442] = 0xBE.toByte(); mbr[443] = 0xEF.toByte()
        // A pre-existing partition entry in slot 0 (the isohybrid ISO partition).
        val existing = PartitionTable.partitionEntry(PartitionTable.Placement(64, 1600), 0x00)
        System.arraycopy(existing, 0, mbr, 446, 16)
        mbr[510] = 0x55; mbr[511] = 0xAA.toByte()
        return mbr
    }
}
