// Runs packages/protocol/test-vectors/keyfile/vectors.json: the v1 and v2 `.flagshipkey` files the
// TypeScript writer made must open here, and every tampered or malformed one must be refused.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.HexUtil
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class KeyfileVectorsTest {
    private val v: JsonObject = run {
        val rel = "packages/protocol/test-vectors/keyfile/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var found: File? = null
        var hops = 0
        while (dir != null && hops < 14 && found == null) {
            val f = File(dir, rel)
            if (f.isFile) found = f
            dir = dir.parentFile
            hops += 1
        }
        Json.parseToJsonElement(requireNotNull(found) { "could not locate $rel" }.readText()).jsonObject
    }
    private val passphrase = v["passphrase"]!!.jsonPrimitive.content

    @Test
    fun goodFilesOpen() {
        for (el in v["open"]!!.jsonArray) {
            val c = el.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val e = c["expect"]!!.jsonObject
            val a = Keyfile.unwrapAccount(c["file"]!!.jsonPrimitive.content, passphrase)
            assertEquals(name, e["version"]!!.jsonPrimitive.content.toInt(), a.version)
            assertEquals(name, e["username"]!!.jsonPrimitive.content, a.meta.username)
            assertArrayEquals(name, HexUtil.decode(e["umkSeedHex"]!!.jsonPrimitive.content), a.umkSeed)
            val admin = e["adminRootSeedHex"]?.jsonPrimitive?.content
            if (admin == null) assertNull(name, a.adminRootSeed) else assertArrayEquals(name, HexUtil.decode(admin), a.adminRootSeed)
            val servers = e["servers"]?.jsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())
            assertEquals(name, servers.size, a.servers.size)
            servers.forEachIndexed { i, s ->
                val o = s.jsonObject
                assertEquals(name, o["domain"]!!.jsonPrimitive.content, a.servers[i].domain)
                assertEquals(name, o["stk"]?.jsonPrimitive?.content, a.servers[i].stk)
                assertEquals(name, o["lan"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList<String>(), a.servers[i].lan)
            }
        }
    }

    @Test
    fun badFilesAreRefused() {
        for (el in v["refuse"]!!.jsonArray) {
            val c = el.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val want = when (c["error"]!!.jsonPrimitive.content) {
                "bad-passphrase" -> Keyfile.KeyfileException.Code.BAD_PASSPHRASE
                "version" -> Keyfile.KeyfileException.Code.VERSION
                else -> Keyfile.KeyfileException.Code.MALFORMED
            }
            try {
                Keyfile.unwrapAccount(c["file"]!!.jsonPrimitive.content, c["passphrase"]?.jsonPrimitive?.content ?: passphrase)
                fail("$name opened")
            } catch (e: Keyfile.KeyfileException) {
                assertEquals(name, want, e.code)
            }
        }
    }
}
