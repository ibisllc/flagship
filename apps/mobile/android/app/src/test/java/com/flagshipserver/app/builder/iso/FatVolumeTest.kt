package com.flagshipserver.app.builder.iso

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proves the pure-Kotlin FAT16 builder emits a spec-valid volume that round-trips:
 * a minimal independent reader re-parses the boot sector, follows the FAT chain,
 * and reconstructs the file bytes. This is the on-device recipe-injection
 * primitive (OTG-BUILDER-NOTES.md §3(b)) — every placement mechanism drops
 * `preseed.cfg` onto exactly this kind of FLAGSHIP-labeled volume.
 */
class FatVolumeTest {
    private fun le16(b: ByteArray, off: Int) = (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8)
    private fun le32(b: ByteArray, off: Int): Long {
        var v = 0L
        for (i in 0 until 4) v = v or ((b[off + i].toLong() and 0xFF) shl (8 * i))
        return v
    }

    private fun ascii(b: ByteArray, off: Int, len: Int) = String(b, off, len, Charsets.US_ASCII)

    @Test
    fun bootSectorHasValidFat16Bpb() {
        val img = FatVolume.buildSingleFile("preseed.cfg", "x".toByteArray())
        // Signature.
        assertEquals(0x55, img[510].toInt() and 0xFF)
        assertEquals(0xAA, img[511].toInt() and 0xFF)
        assertEquals(512, le16(img, 11)) // bytes/sector
        assertEquals(1, img[13].toInt()) // sectors/cluster
        assertEquals(1, le16(img, 14)) // reserved sectors
        assertEquals(2, img[16].toInt()) // num FATs
        assertEquals(512, le16(img, 17)) // root entries
        assertEquals("FAT16   ", ascii(img, 54, 8)) // fs type
        assertEquals("FLAGSHIP   ", ascii(img, 43, 11)) // BPB volume label
        assertTrue("image is a whole number of 512B sectors", img.size % 512 == 0)
    }

    @Test
    fun clusterCountIsInTheValidFat16Range() {
        val img = FatVolume.buildSingleFile("preseed.cfg", "hi".toByteArray())
        val sectorsPerFat = le16(img, 22)
        val reserved = le16(img, 14)
        val numFats = img[16].toInt()
        val rootEntries = le16(img, 17)
        val rootDirSectors = (rootEntries * 32 + 511) / 512
        val totalSectors = if (le16(img, 19) != 0) le16(img, 19).toLong() else le32(img, 32)
        val dataSectors = totalSectors - (reserved + numFats * sectorsPerFat + rootDirSectors)
        val clusters = dataSectors / img[13].toInt()
        // FAT16 is defined as 4085 <= clusters < 65525.
        assertTrue("clusters=$clusters must be > 4084", clusters in 4085..65524)
    }

    @Test
    fun rootDirHasVolumeLabelThenTheFile() {
        val content = "preseed body".toByteArray()
        val img = FatVolume.buildSingleFile("preseed.cfg", content)
        val (rootOff, dataOff) = regions(img)
        // Entry 0 = volume label (attr 0x08).
        assertEquals(0x08, img[rootOff + 11].toInt() and 0xFF)
        assertEquals("FLAGSHIP   ", ascii(img, rootOff, 11))
        // Entry 1 = the file, 8.3 = "PRESEED CFG", archive attr, first cluster 2.
        val fileEntry = rootOff + 32
        assertEquals("PRESEED ", ascii(img, fileEntry, 8))
        assertEquals("CFG", ascii(img, fileEntry + 8, 3))
        assertEquals(0x20, img[fileEntry + 11].toInt() and 0xFF)
        assertEquals(2, le16(img, fileEntry + 26)) // first cluster low
        assertEquals(content.size.toLong(), le32(img, fileEntry + 28)) // file size
        assertTrue(dataOff > rootOff)
    }

    @Test
    fun smallFileRoundTrips() {
        val content = "auto=true priority=critical\npreseed body\n".toByteArray()
        assertEquals(content.toList(), readSingleFile(FatVolume.buildSingleFile("preseed.cfg", content)).toList())
    }

    @Test
    fun multiClusterFileRoundTrips() {
        // > 512B so the FAT chain spans several clusters.
        val content = ByteArray(5000) { (it % 251).toByte() }
        val img = FatVolume.buildSingleFile("preseed.cfg", content)
        assertEquals(content.toList(), readSingleFile(img).toList())
    }

    @Test
    fun buildPreseedVolumeIsUtf8PreseedCfg() {
        val text = "d-i debian-installer/locale string en_US\n"
        val img = FatVolume.buildPreseedVolume(text)
        assertEquals(text.toByteArray(Charsets.UTF_8).toList(), readSingleFile(img).toList())
    }

    // ── minimal independent FAT16 reader (proves the writer, not a shared lib) ──

    private fun regions(img: ByteArray): Pair<Int, Int> {
        val reserved = le16(img, 14)
        val numFats = img[16].toInt()
        val sectorsPerFat = le16(img, 22)
        val rootEntries = le16(img, 17)
        val rootDirSectors = (rootEntries * 32 + 511) / 512
        val rootSector = reserved + numFats * sectorsPerFat
        val dataSector = rootSector + rootDirSectors
        return (rootSector * 512) to (dataSector * 512)
    }

    /** Follow the file entry's FAT chain and reconstruct its exact bytes. */
    private fun readSingleFile(img: ByteArray): ByteArray {
        val reserved = le16(img, 14)
        val fat0 = reserved * 512
        val (rootOff, dataOff) = regions(img)
        val fileEntry = rootOff + 32 // entry 0 is the volume label
        val size = le32(img, fileEntry + 28).toInt()
        var cluster = le16(img, fileEntry + 26)
        val out = ByteArray(size)
        var written = 0
        while (cluster in 2..0xFFEF && written < size) {
            val clusterOff = dataOff + (cluster - 2) * 512
            val take = minOf(512, size - written)
            System.arraycopy(img, clusterOff, out, written, take)
            written += take
            cluster = le16(img, fat0 + cluster * 2)
        }
        assertEquals("FAT chain length matches file size", size, written)
        return out
    }
}
