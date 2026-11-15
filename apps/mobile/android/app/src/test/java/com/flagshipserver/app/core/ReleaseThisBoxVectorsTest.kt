// Runs packages/protocol/test-vectors/box-release/vectors.json, read from disk so a drift fails here.

package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.PqHybrid
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ReleaseThisBoxVectorsTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/box-release/vectors.json"
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
            hops += 1
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun order(o: JsonObject): ReleaseThisBox.Order {
        val t = o["issuedAt"]!!.jsonPrimitive.double
        return ReleaseThisBox.Order(o.s("serverDomain"), o.s("stkPubHex"), if (t == Math.rint(t)) t.toLong() else 0L, o.s("nonceHex"))
    }

    @Test
    fun canonicalBytesAndSignature() {
        val v = vectors()
        val keys = v["keys"]!!.jsonObject
        val o = v["order"]!!.jsonObject
        val ord = order(o["fields"]!!.jsonObject)
        assertEquals(o.s("canonical"), String(ReleaseThisBox.canonicalBytes(ord), Charsets.UTF_8))
        val admin = Ed25519Sign(HexUtil.decode(keys.s("adminRootSeedHex"))!!)
        assertEquals(o.s("signatureHex"), ReleaseThisBox.sign(ord, admin))
        assertTrue(ReleaseThisBox.verify(ord, o.s("signatureHex"), HexUtil.decode(keys.s("adminRootPubHex"))!!))
        for (r in v["reject"]!!.jsonArray) {
            val ro = r.jsonObject
            assertFalse(ro.s("why"), ReleaseThisBox.verify(order(ro["fields"]!!.jsonObject), ro.s("signatureHex"), HexUtil.decode(ro.s("verifyUnder"))!!))
        }
    }

    @Test
    fun hybridSignature() {
        val v = vectors()
        val keys = v["keys"]!!.jsonObject
        val hy = v["hybrid"]!!.jsonObject
        val ord = order(v["order"]!!.jsonObject["fields"]!!.jsonObject)
        val kp = PqHybrid.hybridSigKeygen(HexUtil.decode(keys.s("adminRootSeedHex"))!!, HexUtil.decode(hy.s("adminRootMldsaSeedHex"))!!)
        assertEquals(hy.s("adminRootHybridPubHex"), HexUtil.encode(kp.publicKey))
        val wire = hy["pqSignature"]!!.jsonObject
        assertEquals(ReleaseThisBox.HYBRID_SUITE, wire.s("suite"))
        val mine = PqHybrid.hybridSign(kp.secretKey, ReleaseThisBox.TAG, ReleaseThisBox.canonicalBytes(ord), deterministic = true)
        assertEquals(wire.s("signature"), HexUtil.encode(mine))
        assertTrue(ReleaseThisBox.verifyHybrid(ord, wire.s("signature"), kp.publicKey))
        for (r in hy["reject"]!!.jsonArray) {
            val ro = r.jsonObject
            assertFalse(ro.s("why"), ReleaseThisBox.verifyHybrid(ord, ro.s("signatureHex"), HexUtil.decode(ro.s("verifyUnder"))!!))
        }
    }

    @Test
    fun refusesBadShapes() {
        for (r in vectors()["refuse"]!!.jsonArray) {
            val ro = r.jsonObject
            assertNotNull(ro.s("why"), ReleaseThisBox.problem(order(ro["fields"]!!.jsonObject)))
        }
    }
}
