// Pure-Kotlin FAT16 volume builder — the on-device recipe-injection primitive.
//
// Every viable on-device remaster mechanism (OTG-BURNER-NOTES.md §3(b)) drops
// the per-burn `preseed.cfg` onto a small, FLAGSHIP-labeled FAT volume that a
// pre-remastered Debian base reads (its bootloader cmdline already references
// the label). This builds exactly that volume, deterministically, with no
// native deps. It is the shape-certain half of §3(b): independent of how the
// volume is ultimately placed next to the base image (appended partition vs. a
// pre-allocated region — the base-ISO contract decides that), and independent
// of WHERE the preseed text comes from.
//
// IMPORTANT — this builder does NOT generate the preseed: the security-critical
// preseed/bootstrap text MUST come from the shared generator
// (packages/flagship-burner `buildDebianPreseed`), never a Kotlin
// re-implementation of the signed bootstrap path (OTG-BURNER-NOTES.md §5). This
// only lays already-generated text into a filesystem byte image.
//
// FAT16 is chosen (not FAT32/exFAT) for the smallest correct on-disk format: a
// single boot sector + two FAT copies + a fixed-size root directory. The volume
// is sized so the cluster count stays in the valid FAT16 range (> 4084).

package com.flagshipserver.app.burner.iso

object FatVolume {
    const val BYTES_PER_SECTOR = 512
    private const val SECTORS_PER_CLUSTER = 1
    private const val RESERVED_SECTORS = 1
    private const val NUM_FATS = 2
    private const val ROOT_ENTRIES = 512
    private const val DIR_ENTRY_BYTES = 32

    // FAT16 requires the data-region cluster count to be > 4084 and < 65525.
    // Floor at 4096 so even a tiny preseed yields a spec-valid FAT16 volume.
    private const val MIN_DATA_CLUSTERS = 4096

    private const val ATTR_VOLUME_LABEL = 0x08
    private const val ATTR_ARCHIVE = 0x20

    private const val FAT16_EOC = 0xFFFF // end-of-chain marker
    private const val MEDIA_FIXED = 0xF8

    /**
     * Build a FAT16 volume image holding a single [fileName] (8.3) with [content],
     * labeled [volumeLabel]. Returns the complete filesystem byte image, ready to
     * place onto the USB (next to the base image, per the §3(b) contract).
     */
    fun buildSingleFile(
        fileName: String,
        content: ByteArray,
        volumeLabel: String = "FLAGSHIP",
    ): ByteArray {
        val clusterBytes = BYTES_PER_SECTOR * SECTORS_PER_CLUSTER
        val fileClusters = if (content.isEmpty()) 0 else ceilDiv(content.size, clusterBytes)
        // Headroom keeps the layout comfortably inside the valid range.
        val dataClusters = maxOf(MIN_DATA_CLUSTERS, fileClusters + 16)

        val rootDirSectors = ceilDiv(ROOT_ENTRIES * DIR_ENTRY_BYTES, BYTES_PER_SECTOR)
        // FAT has (dataClusters + 2) 16-bit entries (slots 0/1 are reserved).
        val fatBytes = (dataClusters + 2) * 2
        val sectorsPerFat = ceilDiv(fatBytes, BYTES_PER_SECTOR)

        val totalSectors =
            RESERVED_SECTORS + NUM_FATS * sectorsPerFat + rootDirSectors +
                dataClusters * SECTORS_PER_CLUSTER

        val fat0Sector = RESERVED_SECTORS
        val fat1Sector = fat0Sector + sectorsPerFat
        val rootSector = fat1Sector + sectorsPerFat
        val dataSector = rootSector + rootDirSectors

        val img = ByteArray(totalSectors * BYTES_PER_SECTOR)

        writeBootSector(img, totalSectors, sectorsPerFat, volumeLabel)
        writeFatChains(img, fat0Sector, fat1Sector, sectorsPerFat, fileClusters)
        writeRootDir(img, rootSector, fileName, content.size, fileClusters, volumeLabel)
        // File data starts at cluster 2.
        if (content.isNotEmpty()) {
            System.arraycopy(content, 0, img, dataSector * BYTES_PER_SECTOR, content.size)
        }
        return img
    }

    // ── Boot sector (BPB) ───────────────────────────────────────────────

    private fun writeBootSector(
        img: ByteArray,
        totalSectors: Int,
        sectorsPerFat: Int,
        volumeLabel: String,
    ) {
        // Jump + OEM name.
        img[0] = 0xEB.toByte(); img[1] = 0x3C.toByte(); img[2] = 0x90.toByte()
        putAscii(img, 3, "FLAGSHIP", 8)
        le16(img, 11, BYTES_PER_SECTOR)
        img[13] = SECTORS_PER_CLUSTER.toByte()
        le16(img, 14, RESERVED_SECTORS)
        img[16] = NUM_FATS.toByte()
        le16(img, 17, ROOT_ENTRIES)
        // totalSectors16 if it fits, else 0 (then totalSectors32 carries it).
        if (totalSectors < 0x10000) le16(img, 19, totalSectors) else le16(img, 19, 0)
        img[21] = MEDIA_FIXED.toByte()
        le16(img, 22, sectorsPerFat)
        le16(img, 24, 32) // sectors per track (cosmetic)
        le16(img, 26, 64) // heads (cosmetic)
        le32(img, 28, 0) // hidden sectors
        le32(img, 32, if (totalSectors < 0x10000) 0 else totalSectors)
        // Extended BPB.
        img[36] = 0x80.toByte() // drive number
        img[37] = 0 // reserved
        img[38] = 0x29 // extended boot signature
        le32(img, 39, 0x464C4147) // volume id ("FLAG")
        putAscii(img, 43, volumeLabel, 11)
        putAscii(img, 54, "FAT16", 8)
        img[510] = 0x55; img[511] = 0xAA.toByte()
    }

    // ── FAT tables ──────────────────────────────────────────────────────

    private fun writeFatChains(
        img: ByteArray,
        fat0Sector: Int,
        fat1Sector: Int,
        sectorsPerFat: Int,
        fileClusters: Int,
    ) {
        val fat0 = fat0Sector * BYTES_PER_SECTOR
        // Reserved entries: slot 0 = media | 0xFF00, slot 1 = EOC.
        le16(img, fat0 + 0, 0xFF00 or MEDIA_FIXED)
        le16(img, fat0 + 2, FAT16_EOC)
        // File occupies clusters 2 .. 2+fileClusters-1 (contiguous).
        for (i in 0 until fileClusters) {
            val cluster = 2 + i
            val next = if (i == fileClusters - 1) FAT16_EOC else cluster + 1
            le16(img, fat0 + cluster * 2, next)
        }
        // FAT1 is a byte-for-byte copy of FAT0.
        System.arraycopy(
            img, fat0, img, fat1Sector * BYTES_PER_SECTOR, sectorsPerFat * BYTES_PER_SECTOR,
        )
    }

    // ── Root directory ──────────────────────────────────────────────────

    private fun writeRootDir(
        img: ByteArray,
        rootSector: Int,
        fileName: String,
        fileSize: Int,
        fileClusters: Int,
        volumeLabel: String,
    ) {
        var off = rootSector * BYTES_PER_SECTOR
        // Entry 0: the volume-label directory entry (mirrors the BPB label).
        putAscii(img, off, padLabel(volumeLabel), 11)
        img[off + 11] = ATTR_VOLUME_LABEL.toByte()
        writeFatTimestamp(img, off)
        off += DIR_ENTRY_BYTES
        // Entry 1: the file.
        val (name8, ext3) = split83(fileName)
        putAscii(img, off, name8, 8)
        putAscii(img, off + 8, ext3, 3)
        img[off + 11] = ATTR_ARCHIVE.toByte()
        writeFatTimestamp(img, off)
        le16(img, off + 20, 0) // first cluster high (always 0 on FAT16)
        le16(img, off + 26, if (fileClusters == 0) 0 else 2) // first cluster low
        le32(img, off + 28, fileSize)
    }

    /** Deterministic timestamp: 2026-01-01 00:00:00 (FAT date/time encoding). */
    private fun writeFatTimestamp(img: ByteArray, entryOff: Int) {
        val date = (((2026 - 1980) and 0x7F) shl 9) or (1 shl 5) or 1
        le16(img, entryOff + 22, 0) // write time = 00:00:00
        le16(img, entryOff + 24, date) // write date
        le16(img, entryOff + 16, date) // create date
        le16(img, entryOff + 18, date) // last access date
    }

    // ── helpers ─────────────────────────────────────────────────────────

    /** Split "preseed.cfg" into ("PRESEED ", "CFG"), uppercased + space-padded. */
    private fun split83(fileName: String): Pair<String, String> {
        val dot = fileName.lastIndexOf('.')
        val base = (if (dot >= 0) fileName.substring(0, dot) else fileName).uppercase()
        val ext = (if (dot >= 0) fileName.substring(dot + 1) else "").uppercase()
        return pad(base, 8) to pad(ext, 3)
    }

    private fun padLabel(label: String): String = pad(label.uppercase(), 11)

    private fun pad(s: String, width: Int): String =
        if (s.length >= width) s.substring(0, width) else s + " ".repeat(width - s.length)

    private fun putAscii(img: ByteArray, off: Int, s: String, width: Int) {
        val bytes = pad(s, width).toByteArray(Charsets.US_ASCII)
        System.arraycopy(bytes, 0, img, off, width)
    }

    private fun le16(img: ByteArray, off: Int, v: Int) {
        img[off] = (v and 0xFF).toByte()
        img[off + 1] = ((v ushr 8) and 0xFF).toByte()
    }

    private fun le32(img: ByteArray, off: Int, v: Int) {
        img[off] = (v and 0xFF).toByte()
        img[off + 1] = ((v ushr 8) and 0xFF).toByte()
        img[off + 2] = ((v ushr 16) and 0xFF).toByte()
        img[off + 3] = ((v ushr 24) and 0xFF).toByte()
    }

    private fun ceilDiv(a: Int, b: Int): Int = (a + b - 1) / b

    /** Build the standard preseed volume the §3(b) base image expects. */
    fun buildPreseedVolume(preseedText: String): ByteArray =
        buildSingleFile("preseed.cfg", preseedText.toByteArray(Charsets.UTF_8))
}
