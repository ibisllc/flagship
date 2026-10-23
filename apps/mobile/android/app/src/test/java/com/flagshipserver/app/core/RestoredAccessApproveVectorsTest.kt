// Runs packages/protocol/test-vectors/restored-access-approve/vectors.json (N09).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.GeneralSecurityException

class RestoredAccessApproveVectorsTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/restored-access-approve/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var found: File? = null
        var hops = 0
        while (dir != null && hops < 14 && found == null) {
            val f = File(dir, rel)
            if (f.isFile) found = f
            dir = dir.parentFile
            hops += 1
        }
        return Json.parseToJsonElement(requireNotNull(found) { "could not locate $rel" }.readText()).jsonObject
    }

    private fun order(o: JsonObject) = AppAccessOrders.RestoredApprove(
        o["serviceRef"]!!.jsonPrimitive.content, o["draftSha256"]!!.jsonPrimitive.content, o["issuedAt"]!!.jsonPrimitive.long,
    )

    @Test
    fun canonicalBytesAndSignatureMatchTheVector() {
        val v = vectors()
        val bytes = AppAccessOrders.canonicalBytes(order(v["order"]!!.jsonObject))
        assertEquals(v["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
        val pub = HexUtil.decode(v["adminPubHex"]!!.jsonPrimitive.content)!!
        Ed25519Verify(pub).verify(HexUtil.decode(v["signatureHex"]!!.jsonPrimitive.content)!!, bytes)
    }

    @Test
    fun everyOtherAppOrDraftFailsTheSameSignature() {
        val v = vectors()
        val pub = HexUtil.decode(v["adminPubHex"]!!.jsonPrimitive.content)!!
        val sig = HexUtil.decode(v["signatureHex"]!!.jsonPrimitive.content)!!
        for (c in v["invalid"]!!.jsonArray) {
            val bytes = AppAccessOrders.canonicalBytes(order(c.jsonObject["order"]!!.jsonObject))
            assertEquals(c.jsonObject["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
            assertThrows(GeneralSecurityException::class.java) { Ed25519Verify(pub).verify(sig, bytes) }
        }
        assertTrue(v["invalid"]!!.jsonArray.isNotEmpty())
    }

    @Test
    fun malformedFieldsAreRefused() {
        val ok = "a".repeat(64)
        assertThrows(IllegalArgumentException::class.java) { AppAccessOrders.canonicalBytes(AppAccessOrders.RestoredApprove("a|b", ok, 1)) }
        assertThrows(IllegalArgumentException::class.java) { AppAccessOrders.canonicalBytes(AppAccessOrders.RestoredApprove("alice--chess", "xyz", 1)) }
        assertThrows(IllegalArgumentException::class.java) { AppAccessOrders.canonicalBytes(AppAccessOrders.RestoredApprove("alice--chess", ok, -1)) }
    }
}
