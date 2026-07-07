package com.flagshipserver.app.burner.iso

/**
 * Builds a synthetic GPT disk-prefix (primary header at LBA 1 + a partition-entry
 * array) for the GptReader tests + the SeedInjector test's fake seed. Only the
 * fields GptReader reads are populated (signature, entries-LBA/count/size, and
 * each entry's type-GUID + first/last LBA); CRCs are irrelevant to the reader.
 */
object GptFixtures {
    private val SIG = "EFI PART".toByteArray(Charsets.US_ASCII)

    /** A partition to declare, in 512-byte GPT LBA units. */
    data class Part(val firstLba: Long, val lastLba: Long)

    fun build(
        parts: List<Part>,
        entriesLba: Long = 2,
        entryCount: Int = 128,
        entrySize: Int = 128,
        // A total image at least large enough to hold the entry array; callers can
        // pad further to simulate a longer seed.
        minTotalBytes: Int = 0,
    ): ByteArray {
        val arrayBase = (entriesLba * 512).toInt()
        val needed = arrayBase + entryCount * entrySize
        val disk = ByteArray(maxOf(needed, minTotalBytes))

        val hdr = (1 * 512)
        System.arraycopy(SIG, 0, disk, hdr, SIG.size)
        putLe64(disk, hdr + 72, entriesLba)
        putLe32(disk, hdr + 80, entryCount.toLong())
        putLe32(disk, hdr + 84, entrySize.toLong())

        parts.forEachIndexed { i, p ->
            val off = arrayBase + i * entrySize
            // Non-zero type GUID ⇒ "used" (byte 0 set is enough for GptReader).
            disk[off] = 0x0B
            putLe64(disk, off + 32, p.firstLba)
            putLe64(disk, off + 40, p.lastLba)
        }
        return disk
    }

    private fun putLe32(b: ByteArray, off: Int, v: Long) {
        for (i in 0 until 4) b[off + i] = ((v ushr (8 * i)) and 0xFF).toByte()
    }

    private fun putLe64(b: ByteArray, off: Int, v: Long) {
        for (i in 0 until 8) b[off + i] = ((v ushr (8 * i)) and 0xFF).toByte()
    }
}
