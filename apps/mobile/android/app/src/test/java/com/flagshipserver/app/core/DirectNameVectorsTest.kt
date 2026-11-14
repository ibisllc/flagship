// Runs packages/protocol/test-vectors/direct-name/vectors.json read from disk,
// so a drift from the TS reference fails here (docs/direct-access-and-domains.md §8).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class DirectNameVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/direct-name/vectors.json"
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
    private val keys: JsonObject by lazy { root.o("keys") }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content
    private fun JsonObject.o(k: String): JsonObject = this[k]!!.jsonObject
    private fun bytes(h: String): ByteArray = HexUtil.decode(h)!!
    private val admin by lazy { Ed25519Sign(bytes(keys.s("adminRootSeedHex"))) }

    private fun order(f: JsonObject) = DirectName.Order(
        name = f.s("name"),
        serverDomain = f.s("serverDomain"),
        enabled = f["enabled"]!!.jsonPrimitive.boolean,
        addresses = f["addresses"]!!.jsonArray.map { it.jsonPrimitive.content },
        caa = f.s("caa"),
        issuedAt = f["issuedAt"]!!.jsonPrimitive.long,
    )

    @Test fun ordersVerifyUnderTheAdminRootOnly() {
        val adminPub = bytes(keys.s("adminRootPubHex"))
        val irkPub = bytes(keys.s("irkPubHex"))
        for (name in listOf("follow", "owned", "off")) {
            val c = root.o(name)
            val o = order(c.o("fields"))
            assertEquals(name, c.s("canonical"), String(DirectName.canonical(o), Charsets.UTF_8))
            val pinned = c.s("signatureHex")
            assertTrue(name, DirectName.verify(o, pinned, adminPub))
            assertFalse(name, DirectName.verify(o, pinned, irkPub))
            assertTrue(name, DirectName.verify(o, DirectName.sign(o, admin), adminPub))
        }
    }

    @Test fun refusedOrders() {
        val adminPub = bytes(keys.s("adminRootPubHex"))
        val refused = root["refused"]!!.jsonArray.map { it.jsonObject }
        assertTrue(refused.any { it.s("problem") == "bad-caa" })
        for (r in refused) {
            val label = r.s("name")
            val bad = order(r.o("fields"))
            assertEquals(label, r.s("problem"), DirectName.problem(bad))
            assertThrows(label, IllegalArgumentException::class.java) { DirectName.sign(bad, admin) }
            val forced = HexUtil.encode(admin.sign(DirectName.canonical(bad)))
            assertFalse(label, DirectName.verify(bad, forced, adminPub))
        }
    }

    @Test fun labelKinds() {
        for (k in root["kinds"]!!.jsonArray.map { it.jsonObject }) {
            val label = k.s("label")
            val want = k["kind"].let { if (it == null || it is JsonNull) null else it.jsonPrimitive.content }
            val got = when (DirectName.kind(label)) {
                is DirectName.Kind.Derived -> "derived"
                DirectName.Kind.Vanity -> "vanity"
                null -> null
            }
            assertEquals(label, want, got)
        }
        assertEquals("game--plucky-avocet.fshp.app", DirectName.derivedName("game", "plucky-avocet"))
        assertNull(DirectName.derivedName("game", "x"))
        assertEquals("game--plucky-avocet", DirectName.labelOf("game--plucky-avocet.fshp.app"))
        assertNull(DirectName.labelOf("a.game--plucky-avocet.fshp.app"))
    }
}
