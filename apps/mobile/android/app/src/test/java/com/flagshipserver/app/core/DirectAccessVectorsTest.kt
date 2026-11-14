// Runs packages/protocol/test-vectors/direct-access/vectors.json read from disk,
// so a drift from the TS reference fails here (docs/direct-access-and-domains.md).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
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

class DirectAccessVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/direct-access/vectors.json"
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
    private fun JsonElement.strings(): List<String> = jsonArray.map { it.jsonPrimitive.content }
    private fun bytes(h: String): ByteArray = HexUtil.decode(h)!!
    private fun nullableString(e: JsonElement?): String? = if (e == null || e is JsonNull) null else e.jsonPrimitive.content

    private fun order(f: JsonObject) = DirectAccess.Order(
        serverDomain = f.s("serverDomain"),
        enabled = f["enabled"]!!.jsonPrimitive.boolean,
        addresses = f["addresses"]!!.strings(),
        prefixes = f["prefixes"]!!.strings(),
        port = f["port"]!!.jsonPrimitive.int,
        issuedAt = f["issuedAt"]!!.jsonPrimitive.long,
    )

    private fun endpoints(e: JsonElement) = e.jsonArray.map {
        LanHint.Endpoint(it.jsonObject.s("address"), it.jsonObject["port"]!!.jsonPrimitive.int)
    }

    private fun hint(f: JsonObject) = DirectAccess.HintV2(
        serverDomain = f.s("serverDomain"),
        certSha256 = f.s("certSha256"),
        lan = endpoints(f["lan"]!!),
        direct = endpoints(f["direct"]!!),
        orderSha256 = f.s("orderSha256"),
        issuedAt = f["issuedAt"]!!.jsonPrimitive.long,
        expiresAt = f["expiresAt"]!!.jsonPrimitive.long,
    )

    private val mainOrder by lazy { order(root.o("order").o("fields")) }
    private val stkPub by lazy { bytes(keys.s("stkPubHex")) }

    @Test
    fun addressesAndPrefixes() {
        val a = root.o("addresses")
        for (c in a["canonical"]!!.jsonArray) {
            val o = c.jsonObject
            assertEquals(o.s("input"), nullableString(o["canonical"]), DirectAccess.canonicalIp(o.s("input")))
        }
        for (p in a["public"]!!.strings()) assertTrue(p, DirectAccess.isPublicAddress(p))
        for (p in a["notPublic"]!!.strings()) assertFalse(p, DirectAccess.isPublicAddress(p))
        val pr = root.o("prefixes")
        for (c in pr["valid"]!!.jsonArray) {
            val p = DirectAccess.parsePrefix(c.jsonObject.s("input"))
            assertNotNull(p)
            assertEquals(c.jsonObject.s("canonical"), DirectAccess.formatPrefix(p!!))
        }
        for (s in pr["invalid"]!!.strings()) assertNull(s, DirectAccess.parsePrefix(s))
        for (c in pr["contains"]!!.jsonArray) {
            val o = c.jsonObject
            assertEquals(o["inside"]!!.jsonPrimitive.boolean, DirectAccess.prefixContains(DirectAccess.parsePrefix(o.s("prefix"))!!, o.s("address")))
        }
    }

    @Test
    fun orderBytesHashAndSignatures() {
        val ov = root.o("order")
        val adminPub = bytes(keys.s("adminRootPubHex"))
        val irkPub = bytes(keys.s("irkPubHex"))
        val admin = Ed25519Sign(bytes(keys.s("adminRootSeedHex")))
        assertEquals(ov.s("canonical"), String(DirectAccess.canonical(mainOrder), Charsets.UTF_8))
        assertEquals(ov.s("sha256"), DirectAccess.orderSha256(mainOrder))
        assertTrue(DirectAccess.verify(mainOrder, ov.s("signatureHex"), adminPub))
        assertFalse(DirectAccess.verify(mainOrder, ov.s("signatureHex"), irkPub))
        assertTrue(DirectAccess.verify(DirectAccess.SignedOrder(mainOrder, ov.s("signatureHex")), listOf(irkPub, adminPub)))
        assertTrue(DirectAccess.verify(mainOrder, DirectAccess.sign(mainOrder, admin), adminPub))
        val off = ov.o("off")
        val offOrder = order(off.o("fields"))
        assertEquals(off.s("canonical"), String(DirectAccess.canonical(offOrder), Charsets.UTF_8))
        assertTrue(DirectAccess.verify(offOrder, off.s("signatureHex"), adminPub))
        for (r in ov["refused"]!!.jsonArray) {
            val bad = order(r.jsonObject.o("fields"))
            val name = r.jsonObject.s("name")
            assertEquals(name, r.jsonObject.s("problem"), DirectAccess.problem(bad))
            assertThrows(IllegalArgumentException::class.java) { DirectAccess.sign(bad, admin) }
            assertFalse(name, DirectAccess.verify(bad, HexUtil.encode(admin.sign(DirectAccess.canonical(bad))), adminPub))
        }
    }

    @Test
    fun addressUpdates() {
        val av = root.o("addressUpdate")
        fun update(f: JsonObject) = DirectAccess.AddressUpdate(
            f.s("serverDomain"), f.s("orderSha256"), f["addresses"]!!.strings(), f["port"]!!.jsonPrimitive.int, f["issuedAt"]!!.jsonPrimitive.long,
        )
        assertEquals(av.s("canonical"), String(DirectAccess.canonical(update(av.o("fields"))), Charsets.UTF_8))
        for (c in av["cases"]!!.jsonArray) {
            val o = c.jsonObject
            val ord = o["order"]?.jsonObject?.let(::order) ?: mainOrder
            val why = DirectAccess.reject(update(o.o("fields")), bytes(o.s("signatureHex")), stkPub, ord, mainOrder.serverDomain, av["now"]!!.jsonPrimitive.long)
            assertEquals(o.s("name"), nullableString(o["reason"]), why)
        }
    }

    @Test
    fun hintV2() {
        val hv = root.o("hintV2")
        val base = hint(hv.o("fields"))
        assertEquals(hv.s("canonical"), String(DirectAccess.canonical(base), Charsets.UTF_8))
        for (c in hv["cases"]!!.jsonArray) {
            val o = c.jsonObject
            val withOrder = o["withOrder"]!!.jsonPrimitive.boolean
            val ord = if (withOrder) o["order"]?.jsonObject?.let(::order) ?: mainOrder else null
            val got = DirectAccess.check(hint(o.o("fields")), bytes(o.s("signatureHex")), stkPub, base.serverDomain, base.certSha256, hv["now"]!!.jsonPrimitive.long, ord)
            val reason = nullableString(o["reason"])
            val want = if (reason != null) DirectAccess.HintVerdict.Refused(reason) else DirectAccess.HintVerdict.Accepted(o["useDirect"]!!.jsonPrimitive.boolean)
            assertEquals(o.s("name"), want, got)
        }
    }
}
