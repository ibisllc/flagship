package com.flagshipserver.app.burner.iso

import com.flagshipserver.app.burner.usb.MassStorageWriter
import com.flagshipserver.app.burner.usb.RecordingDiskDevice
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Proves the seed-and-append injector (option 4) end to end without hardware:
 * inject() returns a recipe-embedded image plus a placement hook, and running
 * that hook against a fake USB disk OVERWRITES the seed's pre-declared,
 * GPT-registered FLAGSHIP region with the preseed FAT volume (zero-padded to the
 * region) — touching NO other sectors (no MBR splice, no GPT edit). Also proves
 * it fails LOUDLY when the preseed source can't deliver and when the seed carries
 * no GPT.
 */
class SeedInjectorTest {
    private val preseed = "d-i debian-installer/locale string en_US\n# FLAGSHIP per-recipe preseed\n"

    // FLAGSHIP region: 2 MiB offset (LBA 4096), 16 MiB long — matches the seed
    // build's MiB-aligned pre-declared partition.
    private val flagshipFirstLba = 4096L
    private val flagshipLastLba = flagshipFirstLba + (16L * 1024 * 1024 / 512) - 1

    private fun recipe() = ParsedRecipe(
        serial = "AB12-CD34",
        serverName = "home",
        serverDomain = "home.alice.flagship.services",
        username = "alice",
        blobSignatureHex = "deadbeef",
        expiresAt = null,
    )

    /** A seed file whose GPT pre-declares the FLAGSHIP region (the seed-build output). */
    private fun seedWithGpt(): File {
        val bytes = GptFixtures.build(
            listOf(
                GptFixtures.Part(firstLba = 64, lastLba = 3000),                  // ISO
                GptFixtures.Part(firstLba = flagshipFirstLba, lastLba = flagshipLastLba), // FLAGSHIP
            ),
            minTotalBytes = 1_000_000,
        )
        val f = File.createTempFile("seed", ".iso")
        f.deleteOnExit()
        f.writeBytes(bytes)
        return f
    }

    private fun seedNoGpt(bytes: Int): File {
        val f = File.createTempFile("seed", ".iso")
        f.deleteOnExit()
        f.writeBytes(ByteArray(bytes) { (it % 251).toByte() })
        return f
    }

    @Test
    fun injectReportsEmbeddedAndCarriesAPlacement() {
        val seed = seedWithGpt()
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
    fun placementOverwritesTheFlagshipRegionAndNothingElse() {
        val seed = seedWithGpt()
        val injected = SeedInjector({ _, _ -> preseed }).inject(seed, recipe(), "{}")

        val dev = RecordingDiskDevice(blockSize = 512, capacityBlocks = 100_000)
        val writer = MassStorageWriter(dev)
        val cap = writer.readCapacity()
        injected.placement!!.place(writer, cap)
        injected.closeable.close()

        val fatVolume = FatVolume.buildPreseedVolume(preseed)
        val regionSize = (flagshipLastLba - flagshipFirstLba + 1) * 512

        // The FAT volume lands at the region start, byte-for-byte, and the rest of
        // the region is zero-padded.
        val readBack = writer.readSectors(flagshipFirstLba, (regionSize / 512).toInt(), 512)
        assertArrayEquals(fatVolume, readBack.copyOfRange(0, fatVolume.size))
        for (i in fatVolume.size until readBack.size) {
            assertEquals("region tail must be zero at $i", 0, readBack[i].toInt())
        }

        // NO write ever touched LBA 0 (no MBR splice) and every write is inside
        // the FLAGSHIP region.
        assertFalse("must not write the MBR", dev.writes.any { it.first == 0L })
        val minLba = dev.writes.minOf { it.first }
        val maxLba = dev.writes.maxOf { it.first + it.second }
        assertEquals(flagshipFirstLba, minLba)
        assertTrue(maxLba <= flagshipLastLba + 1)
    }

    @Test
    fun placementFailsLoudlyWhenTheSeedHasNoGpt() {
        val seed = seedNoGpt(500_000)
        val injected = SeedInjector({ _, _ -> preseed }).inject(seed, recipe(), "{}")
        val dev = RecordingDiskDevice(blockSize = 512, capacityBlocks = 100_000)
        val writer = MassStorageWriter(dev)
        val cap = writer.readCapacity()
        assertThrows(GptReader.GptException::class.java) {
            injected.placement!!.place(writer, cap)
        }
        injected.closeable.close()
    }

    @Test
    fun injectFailsLoudlyOnBlankPreseed() {
        val seed = seedNoGpt(1000)
        assertThrows(IllegalStateException::class.java) {
            SeedInjector({ _, _ -> "   " }).inject(seed, recipe(), "{}")
        }
    }

    @Test
    fun injectFailsLoudlyWhenPreseedSourceThrows() {
        val seed = seedNoGpt(1000)
        val ex = assertThrows(IllegalStateException::class.java) {
            SeedInjector({ _, _ -> throw RuntimeException("engine boom") }).inject(seed, recipe(), "{}")
        }
        assertTrue(ex.message!!.contains("couldn't generate the preseed"))
    }
}
