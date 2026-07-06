// Proves the generation+volume half of on-device injection: PreseedFatInjector
// chains the canonical generator (Rhino) → the FLAGSHIP FAT volume, and the
// preseed.cfg read back out of the volume equals the golden expectedPreseed.

package com.flagshipserver.app.burner.iso

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class PreseedFatInjectorTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun repoFile(rel: String): File {
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        try {
            val loc = javaClass.protectionDomain?.codeSource?.location
            if (loc != null) candidates.add(File(loc.toURI()))
        } catch (_: Throwable) {
        }
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 14) {
                val f = File(dir, rel)
                if (f.isFile) return f
                dir = dir.parentFile
                hops += 1
            }
        }
        fail("could not locate $rel from " + candidates.joinToString { it.absolutePath })
        error("unreachable")
    }

    private val canonicalBundle by lazy { repoFile("packages/flagship-burner/engine/preseed-engine.js") }
    private val goldenVectors by lazy { repoFile("packages/flagship-burner/engine/golden/preseed-vectors.json") }

    private fun vectors(): List<JsonObject> {
        val root = json.parseToJsonElement(goldenVectors.readText()).jsonObject
        return root["vectors"]!!.jsonArray.map { it.jsonObject }
    }

    // ── minimal independent FAT16 reader (mirrors FatVolumeTest) ──
    private fun le16(b: ByteArray, off: Int) = (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8)
    private fun le32(b: ByteArray, off: Int): Long {
        var v = 0L
        for (i in 0 until 4) v = v or ((b[off + i].toLong() and 0xFF) shl (8 * i))
        return v
    }

    private fun readSingleFile(img: ByteArray): ByteArray {
        val reserved = le16(img, 14)
        val numFats = img[16].toInt()
        val sectorsPerFat = le16(img, 22)
        val rootEntries = le16(img, 17)
        val rootDirSectors = (rootEntries * 32 + 511) / 512
        val rootSector = reserved + numFats * sectorsPerFat
        val dataSector = rootSector + rootDirSectors
        val fat0 = reserved * 512
        val rootOff = rootSector * 512
        val dataOff = dataSector * 512
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

    @Test
    fun volumeCarriesTheGoldenPreseedForEveryVector() {
        val eng = PreseedEngine(canonicalBundle.readText(Charsets.UTF_8))
        val vs = vectors()
        assertTrue("expected golden vectors, found none", vs.isNotEmpty())
        for (v in vs) {
            val name = v["name"]!!.jsonPrimitive.content
            val recipeJson = v["recipeJson"]!!.jsonPrimitive.content
            val burnOptsJson = v["burnOptsJson"]!!.jsonPrimitive.content
            val expectedPreseed = v["expectedPreseed"]!!.jsonPrimitive.content

            val img = PreseedFatInjector.buildPreseedVolume(eng, recipeJson, burnOptsJson)
            // The FLAGSHIP volume label is what the pre-remastered base reads.
            assertEquals(
                "vector '$name': BPB volume label",
                "FLAGSHIP   ",
                String(img, 43, 11, Charsets.US_ASCII),
            )
            val readBack = readSingleFile(img).toString(Charsets.UTF_8)
            assertEquals("vector '$name': preseed.cfg in the FAT volume", expectedPreseed, readBack)
        }
    }
}
