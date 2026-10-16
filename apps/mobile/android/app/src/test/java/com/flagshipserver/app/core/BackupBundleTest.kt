// The one-file backup (`<name>.flagship`): pinned to
// packages/protocol/test-vectors/server-backup-bundle, every invalid case
// refused with a sentence. Mirrors the iOS BackupBundleTests.

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class BackupBundleTest {
    private val root: JsonObject by lazy {
        val rel = "packages/protocol/test-vectors/server-backup-bundle/vectors.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        runCatching { javaClass.protectionDomain?.codeSource?.location?.toURI()?.let { candidates.add(File(it)) } }
        var found: File? = null
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 14 && found == null) {
                File(dir, rel).takeIf { it.isFile }?.let { found = it }
                dir = dir.parentFile
                hops += 1
            }
        }
        Json.parseToJsonElement((found ?: error("could not locate $rel")).readText()).jsonObject
    }

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    @Test fun headersMatchTheSharedVectors() {
        for (h in root["headers"]!!.jsonArray.map { it.jsonObject }) {
            val len = h["metaLength"]!!.jsonPrimitive.int
            assertEquals(h.s("headerHex"), HexUtil.encode(ServerBackupFormat.bundleHeader(len)))
            val layout = ServerBackupFormat.parseBundleHeader(HexUtil.decode(h.s("headerHex"))!!, 16L + len + 1)
            assertEquals(len, layout.metaLength)
            assertEquals(16L + len, layout.dataOffset)
            assertEquals(1L, layout.dataLength)
        }
    }

    @Test fun theExampleSplitsIntoItsTwoParts() {
        val e = root["example"]!!.jsonObject
        val bundle = HexUtil.decode(e.s("bundleHex"))!!
        val meta = HexUtil.decode(e.s("metaHex"))!!
        val data = HexUtil.decode(e.s("dataHex"))!!
        assertArrayEquals(bundle, ServerBackupFormat.bundleHeader(meta.size) + meta + data)
        val layout = ServerBackupFormat.parseBundleHeader(bundle.copyOf(16), bundle.size.toLong())
        assertEquals(e["metaLength"]!!.jsonPrimitive.int, layout.metaLength)
        assertEquals(e["dataOffset"]!!.jsonPrimitive.long, layout.dataOffset)
        assertArrayEquals(meta, bundle.copyOfRange(16, layout.dataOffset.toInt()))
        assertArrayEquals(data, bundle.copyOfRange(layout.dataOffset.toInt(), bundle.size))
    }

    @Test fun everyInvalidCaseIsRefusedWithASentence() {
        val invalid = root["invalid"]!!.jsonArray.map { it.jsonObject }
        assertTrue(invalid.isNotEmpty())
        for (bad in invalid) {
            try {
                ServerBackupFormat.parseBundleHeader(HexUtil.decode(bad.s("headHex"))!!, bad["fileBytes"]!!.jsonPrimitive.long)
                fail("accepted: ${bad.s("why")}")
            } catch (e: ServerBackupFormat.BundleException) {
                val m = e.message!!
                assertTrue(m, m.first().isUpperCase() && m.endsWith("."))
            }
        }
        try {
            ServerBackupFormat.bundleHeader(0)
            fail("a zero-length metadata part")
        } catch (_: ServerBackupFormat.BundleException) {
        }
    }

    @Test fun aU64AboveLongMaxIsDamagedNotNegative() {
        val head = HexUtil.decode("464c475348424b31ffffffffffffffff")!!
        try {
            ServerBackupFormat.parseBundleHeader(head, 100)
            fail("accepted")
        } catch (e: ServerBackupFormat.BundleException) {
            assertEquals("This backup's header is damaged.", e.message)
        }
    }

    @Test fun theFileNameDropsThePartExtension() {
        assertEquals("home-2026-10-16-0300.flagship", ServerBackupFormat.bundleFileName("home-2026-10-16-0300.flagship-data"))
        assertEquals("home-2026-10-16-0300.flagship", ServerBackupFormat.bundleFileName("home-2026-10-16-0300.flagship-backup"))
    }
}
