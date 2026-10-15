// Runs every case in packages/protocol/test-vectors/server-archive/vectors.json,
// read from disk so a drift fails here.

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ServerArchiveVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/server-archive/vectors.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        runCatching { javaClass.protectionDomain?.codeSource?.location?.toURI()?.let { candidates.add(File(it)) } }
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
        fail("could not locate $rel")
        error("unreachable")
    }

    private val root: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content

    @Test fun keysMatchTheSharedVectors() {
        val cases = root["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val key = ServerArchive.deriveKey(HexUtil.decode(c.s("umkSeedHex"))!!, c.s("archiveIdHex"))
            assertEquals(c.s("keyHex"), HexUtil.encode(key!!))
        }
    }

    @Test fun refusesBadArchiveIds() {
        val umk = ByteArray(32) { 9 }
        for (bad in root["invalidArchiveIds"]!!.jsonArray.map { it.jsonPrimitive.content }) {
            assertNull(bad, ServerArchive.deriveKey(umk, bad))
        }
        assertNull(ServerArchive.deriveKey(ByteArray(5), "a".repeat(32)))
    }

    @Test fun readsAHeaderAndRefusesOtherFiles() {
        val head = ("{\"magic\":\"flagship-archive\",\"v\":1,\"archiveId\":\"00112233445566778899aabbccddeeff\"," +
            "\"createdAt\":5,\"sourceServer\":\"home.alice.flagship.services\",\"apps\":[{\"serviceId\":\"alice--wiki\",\"name\":\"Wiki\"}]}\nBINARY")
            .toByteArray()
        val h = ServerArchive.parseHeader(head)
        assertEquals("00112233445566778899aabbccddeeff", h.archiveId)
        assertEquals(listOf("Wiki"), h.appNames)
        assertEquals("That isn't a Flagship backup.", assertThrows(ServerArchive.HeaderException::class.java) { ServerArchive.parseHeader("hello\n".toByteArray()) }.message)
        assertTrue(assertThrows(ServerArchive.HeaderException::class.java) { ServerArchive.parseHeader("{\"magic\":\"flagship-archive\",\"v\":2}\n".toByteArray()) }.message!!.contains("newer version"))
        assertTrue(assertThrows(ServerArchive.HeaderException::class.java) { ServerArchive.parseHeader("{\"magic\":\"flagship-archive\",\"v\":1,\"archiveId\":\"zz\"}\n".toByteArray()) }.message!!.contains("damaged"))
    }

    @Test fun namesAndSizes() {
        assertEquals("Home-2026-10-14.flagship-backup", ServerArchive.fileName("Home.alice.flagship.services", 1_792_000_000_000L))
        assertEquals("900 KB", ServerArchive.formatBytes(900L * 1024))
        assertEquals("5.0 MB", ServerArchive.formatBytes(5L * 1024 * 1024))
        assertEquals("3.0 GB", ServerArchive.formatBytes(3L * 1024 * 1024 * 1024))
    }
}
