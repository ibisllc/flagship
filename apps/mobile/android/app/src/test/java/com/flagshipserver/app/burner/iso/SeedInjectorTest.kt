package com.flagshipserver.app.burner.iso

import com.flagshipserver.app.burner.usb.MassStorageWriter
import com.flagshipserver.app.burner.usb.RecordingDiskDevice
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Proves the seed-and-append injector end to end without hardware: inject()
 * returns a recipe-embedded image plus a placement hook, and running that hook
 * against a fake USB disk lays the FLAGSHIP FAT volume at the computed LBA and
 * splices its partition entry into slot 3 of LBA 0 while preserving the seed's
 * isohybrid MBR. Also proves it fails LOUDLY when the preseed source can't
 * deliver — never a silent verbatim write.
 */
class SeedInjectorTest {
    private val preseed = "d-i debian-installer/locale string en_US\n# FLAGSHIP per-recipe preseed\n"

    private fun recipe() = ParsedRecipe(
        serial = "AB12-CD34",
        serverName = "home",
        serverDomain = "home.alice.flagship.services",
        username = "alice",
        blobSignatureHex = "deadbeef",
        expiresAt = null,
    )

    private fun seedFile(bytes: Int): File {
        val f = File.createTempFile("seed", ".iso")
        f.deleteOnExit()
        f.writeBytes(ByteArray(bytes) { (it % 251).toByte() })
        return f
    }

    /** An isohybrid-like MBR to pre-seed LBA 0 (the verbatim seed write does this on real hardware). */
    private fun isohybridMbr(): ByteArray {
        val mbr = ByteArray(512)
        for (i in 0 until 440) mbr[i] = ((i * 3) and 0xFF).toByte()
        mbr[440] = 0x12; mbr[441] = 0x34; mbr[442] = 0x56; mbr[443] = 0x78
        val existing = PartitionTable.partitionEntry(PartitionTable.Placement(64, 2000), 0x00)
        System.arraycopy(existing, 0, mbr, 446, 16)
        mbr[510] = 0x55; mbr[511] = 0xAA.toByte()
        return mbr
    }

    @Test
    fun injectReportsEmbeddedAndCarriesAPlacement() {
        val seed = seedFile(1_500_000)
        val injected = SeedInjector({ _, _ -> preseed }).inject(seed, recipe(), "{}")
        try {
            assertTrue("recipe must be reported embedded", injected.recipeEmbedded)
            assertEquals(seed.length(), injected.totalBytes)
            assertNotNull("seed injector must carry a placement hook", injected.placement)
        } finally {
            injected.closeable.close()
        }
    }

    @Test
    fun placementLaysTheFatVolumeAndPatchesTheMbr() {
        val seed = seedFile(1_500_000)
        val injected = SeedInjector({ _, _ -> preseed }).inject(seed, recipe(), "{}")

        val dev = RecordingDiskDevice(blockSize = 512, capacityBlocks = 1_000_000)
        val writer = MassStorageWriter(dev)
        // Simulate the verbatim seed write having laid an isohybrid MBR at LBA 0.
        val originalMbr = isohybridMbr()
        writer.writeSectors(originalMbr, startLba = 0, blockSize = 512)

        val cap = writer.readCapacity()
        injected.placement!!.place(writer, cap)
        injected.closeable.close()

        val fatVolume = FatVolume.buildPreseedVolume(preseed)
        val place = PartitionTable.placeFatVolume(seed.length(), fatVolume.size, 512, cap.lastLba)

        // 1. The FLAGSHIP FAT volume is at the computed LBA, byte-for-byte.
        val readBack = writer.readSectors(place.startLba, place.sectorCount.toInt(), 512)
        assertArrayEquals(fatVolume, readBack.copyOfRange(0, fatVolume.size))

        // 2. Slot 3 of LBA 0 holds the FLAGSHIP entry; the isohybrid MBR is otherwise intact.
        val patchedMbr = writer.readSectors(0, 1, 512)
        val expectedEntry = PartitionTable.partitionEntry(place, PartitionTable.TYPE_FAT16_LBA)
        assertArrayEquals(expectedEntry, patchedMbr.copyOfRange(446 + 3 * 16, 446 + 4 * 16))
        assertArrayEquals(originalMbr.copyOfRange(0, 446 + 3 * 16), patchedMbr.copyOfRange(0, 446 + 3 * 16))
        assertEquals(0x55, patchedMbr[510].toInt() and 0xFF)
        assertEquals(0xAA, patchedMbr[511].toInt() and 0xFF)
    }

    @Test
    fun injectFailsLoudlyOnBlankPreseed() {
        val seed = seedFile(1000)
        assertThrows(IllegalStateException::class.java) {
            SeedInjector({ _, _ -> "   " }).inject(seed, recipe(), "{}")
        }
    }

    @Test
    fun injectFailsLoudlyWhenPreseedSourceThrows() {
        val seed = seedFile(1000)
        val ex = assertThrows(IllegalStateException::class.java) {
            SeedInjector({ _, _ -> throw RuntimeException("engine boom") }).inject(seed, recipe(), "{}")
        }
        assertTrue(ex.message!!.contains("couldn't generate the preseed"))
    }
}
