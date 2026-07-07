package com.flagshipserver.app.burner.iso

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Pins the GPT reader for the seed-and-append burn (option 4): it finds the
 * appended FLAGSHIP partition (the entry with the HIGHEST first_lba), returns its
 * byte offset + size in 512-byte GPT LBA units, enforces device-block alignment,
 * and rejects a missing/invalid GPT or a GPT with no usable partitions.
 */
class GptReaderTest {

    @Test
    fun findsThePartitionWithTheHighestFirstLba() {
        // ISO/ESP-ish partitions plus the appended FLAGSHIP region at the top.
        val disk = GptFixtures.build(
            listOf(
                GptFixtures.Part(firstLba = 64, lastLba = 1000),   // ISO
                GptFixtures.Part(firstLba = 4096, lastLba = 36863), // FLAGSHIP (highest)
                GptFixtures.Part(firstLba = 1200, lastLba = 1400),  // ESP
            ),
        )
        val region = GptReader.findFlagshipRegion(GptReader.fromBytes(disk), deviceBlockSize = 512)
        assertEquals(4096L * 512, region.offsetBytes)
        assertEquals((36863L - 4096 + 1) * 512, region.sizeBytes)
    }

    @Test
    fun highestFirstLbaWinsRegardlessOfArrayOrder() {
        val disk = GptFixtures.build(
            listOf(
                GptFixtures.Part(firstLba = 50000, lastLba = 60000), // highest, first in array
                GptFixtures.Part(firstLba = 64, lastLba = 1000),
            ),
        )
        val region = GptReader.findFlagshipRegion(GptReader.fromBytes(disk), 512)
        assertEquals(50000L * 512, region.offsetBytes)
    }

    @Test
    fun skipsUnusedEntriesBetweenUsedOnes() {
        // entryCount 128 with only two used entries at indices 0 and 5 (the rest
        // are all-zero ⇒ skipped). Placed by giving two parts (indices 0,1) then
        // manually clearing index 1 would be awkward; instead rely on the builder
        // writing only the two provided parts, leaving 126 zeroed entries.
        val disk = GptFixtures.build(
            listOf(
                GptFixtures.Part(firstLba = 64, lastLba = 1000),
                GptFixtures.Part(firstLba = 9000, lastLba = 9999),
            ),
        )
        val region = GptReader.findFlagshipRegion(GptReader.fromBytes(disk), 512)
        assertEquals(9000L * 512, region.offsetBytes)
        assertEquals((9999L - 9000 + 1) * 512, region.sizeBytes)
    }

    @Test
    fun rejectsAMissingOrInvalidGpt() {
        val notGpt = ByteArray(4096) // no "EFI PART" at LBA 1
        val ex = assertThrows(GptReader.GptException::class.java) {
            GptReader.findFlagshipRegion(GptReader.fromBytes(notGpt), 512)
        }
        assertEquals(true, ex.message!!.contains("no GPT"))
    }

    @Test
    fun rejectsAGptWithNoUsablePartition() {
        val disk = GptFixtures.build(emptyList())
        val ex = assertThrows(GptReader.GptException::class.java) {
            GptReader.findFlagshipRegion(GptReader.fromBytes(disk), 512)
        }
        assertEquals(true, ex.message!!.contains("no usable partition"))
    }

    @Test
    fun rejectsAnUnalignedRegionForTheDeviceBlockSize() {
        // firstLba 33 ⇒ byte offset 33*512 = 16896; not a multiple of a 2048-byte
        // device block (16896 % 2048 = 512).
        val disk = GptFixtures.build(listOf(GptFixtures.Part(firstLba = 33, lastLba = 100)))
        val ex = assertThrows(GptReader.GptException::class.java) {
            GptReader.findFlagshipRegion(GptReader.fromBytes(disk), deviceBlockSize = 2048)
        }
        assertEquals(true, ex.message!!.contains("not aligned"))
    }

    @Test
    fun acceptsAnAlignedRegionForA2048ByteDevice() {
        // firstLba 4096 ⇒ 4096*512 = 2 MiB, divisible by 2048.
        val disk = GptFixtures.build(listOf(GptFixtures.Part(firstLba = 4096, lastLba = 36863)))
        val region = GptReader.findFlagshipRegion(GptReader.fromBytes(disk), deviceBlockSize = 2048)
        assertEquals(4096L * 512, region.offsetBytes)
    }
}
