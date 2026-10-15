// Runs packages/protocol/test-vectors/box-proxy/vectors.json
// (docs/outbound-proxy.md), read from disk so a drift fails here: the signed
// order the phone sends when the owner sets a server's outbound proxy.

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class BoxProxyVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/box-proxy/vectors.json"
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

    private fun proxy(f: JsonObject) = BoxProxy(
        serverDomain = f.s("serverDomain"),
        kind = f.s("kind"),
        host = f.s("host"),
        port = f["port"]!!.jsonPrimitive.int,
        auth = f["auth"]!!.jsonPrimitive.boolean,
        fallbackDirect = f["fallbackDirect"]!!.jsonPrimitive.boolean,
        issuedAt = f["issuedAt"]!!.jsonPrimitive.long,
        nonce = f.s("nonce"),
    )

    @Test fun derivesTheIrk() {
        assertEquals(keys.s("irkPubHex"), HexUtil.encode(ServerKeys.deriveProtocolIrkPub(umk)))
    }

    @Test fun reproducesEveryCase() {
        val irk = ServerKeys.deriveProtocolIrk(umk)
        val pub = bytes(keys.s("irkPubHex"))
        for (c in root["cases"]!!.jsonArray.map { it.jsonObject }) {
            val p = proxy(c.o("fields"))
            assertEquals(c.s("name"), c.s("canonical"), String(BoxProxyProtocol.canonicalBytes(p)))
            assertEquals(c.s("name"), c.s("signatureHex"), BoxProxyProtocol.sign(p, irk))
            assertTrue(c.s("name"), BoxProxyProtocol.verify(p, c.s("signatureHex"), pub))
            assertFalse(c.s("name"), BoxProxyProtocol.verify(p, c.s("rejectSignatureHex"), pub))
        }
    }

    @Test fun decodesTheWireForm() {
        val c = root["cases"]!!.jsonArray.first().jsonObject
        val wire = Json.decodeFromString(BoxProxyWire.serializer(), c.o("wire").toString())
        assertEquals(proxy(c.o("fields")), wire.proxy)
        assertEquals(c.s("signatureHex"), wire.signature)
    }

    @Test fun refusesEveryRefuseCase() {
        for (r in root["refuse"]!!.jsonArray) {
            val c = r.jsonObject
            assertThrows(c.s("why"), IllegalArgumentException::class.java) {
                BoxProxyProtocol.canonicalBytes(proxy(c.o("fields")))
            }
        }
    }

    @Test fun normalizesTypedHosts() {
        for (n in root["normalize"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(n.s("host"), BoxProxyProtocol.normalizeHost(n.s("input")))
        }
    }

    @Test fun checksCredentialsTheSameWay() {
        val creds = root.o("credentials")
        for (c in creds["accept"]!!.jsonArray.map { it.jsonObject }) {
            assertNull(BoxProxyProtocol.credentialsError(c.s("username"), c.s("password")))
        }
        for (c in creds["refuse"]!!.jsonArray.map { it.jsonObject }) {
            assertNotNull(c.s("why"), BoxProxyProtocol.credentialsError(c.s("username"), c.s("password")))
        }
    }
}
