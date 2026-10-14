// Runs packages/protocol/test-vectors/server-order/vectors.json
// (docs/server-order.md), read from disk so a drift fails here: the signed
// order the phone posts when the owner reorders their servers.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ServerOrderVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/server-order/vectors.json"
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
    private val keys: JsonObject by lazy { root["keys"]!!.jsonObject }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content
    private fun JsonObject.o(k: String): JsonObject = this[k]!!.jsonObject
    private fun bytes(h: String): ByteArray = HexUtil.decode(h)!!
    private val umk by lazy { bytes(keys.s("umkSeedHex")) }

    private fun order(f: JsonObject) = ServerOrder(
        user = f.s("user"),
        stks = f["stks"]!!.jsonArray.map { it.jsonPrimitive.content },
        issuedAt = f["issuedAt"]!!.jsonPrimitive.long,
        nonce = f.s("nonce"),
    )

    private fun verifies(sigHex: String, canonical: String): Boolean =
        runCatching { Ed25519Verify(bytes(keys.s("irkPubHex"))).verify(bytes(sigHex), canonical.toByteArray()) }.isSuccess

    @Test fun derivesTheIrkAndCgk() {
        assertEquals(keys.s("irkPubHex"), HexUtil.encode(ServerKeys.deriveProtocolIrkPub(umk)))
        assertEquals(keys.s("cgkHex"), HexUtil.encode(CloudGossip.deriveCGK(umk)))
    }

    @Test fun reproducesTheOrder() {
        val v = root.o("order")
        val o = order(v.o("fields"))
        assertEquals(v.s("canonical"), String(ServerOrderProtocol.canonicalBytes(o)))
        assertEquals(v.s("signatureHex"), ServerOrderProtocol.sign(o, ServerKeys.deriveProtocolIrk(umk)))
        assertTrue(ServerOrderProtocol.verify(o, v.s("signatureHex"), bytes(keys.s("irkPubHex"))))
        assertTrue(verifies(v.s("signatureHex"), v.s("canonical")))
        assertFalse(ServerOrderProtocol.verify(o, v.o("reject").s("signatureHex"), bytes(keys.s("irkPubHex"))))
    }

    @Test fun decodesTheWireForm() {
        val v = root.o("order")
        val wire = Json.decodeFromString(ServerOrderWire.serializer(), v.o("wire").toString())
        assertEquals(order(v.o("fields")), wire.order)
        assertEquals(v.s("signatureHex"), wire.signature)
    }

    @Test fun refusesEveryRefuseCase() {
        for (r in root["refuse"]!!.jsonArray) {
            val c = r.jsonObject
            assertThrows(c.s("why"), IllegalArgumentException::class.java) {
                ServerOrderProtocol.canonicalBytes(order(c.o("fields")))
            }
        }
    }
}
