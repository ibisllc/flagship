// Runs packages/protocol/test-vectors/companion-delegation/vectors.json (SEC-AUTH-002).

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
import org.junit.Test
import java.io.File
import java.security.GeneralSecurityException

class CompanionDelegationVectorsTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/companion-delegation/vectors.json"
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

    private fun order(o: JsonObject) = CompanionDelegation.Order(
        o["sessionId"]!!.jsonPrimitive.content,
        o["serviceRef"]!!.jsonPrimitive.content,
        o["ops"]!!.jsonArray.map { it.jsonPrimitive.content },
        o["issuedAt"]!!.jsonPrimitive.long,
        o["expiresAt"]!!.jsonPrimitive.long,
    )

    @Test
    fun canonicalBytesSortTheOperationsAndMatchTheSignature() {
        val v = vectors()
        val bytes = CompanionDelegation.canonicalBytes(order(v["delegation"]!!.jsonObject))
        assertEquals(v["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
        Ed25519Verify(HexUtil.decode(v["adminPubHex"]!!.jsonPrimitive.content)!!).verify(HexUtil.decode(v["signatureHex"]!!.jsonPrimitive.content)!!, bytes)
    }

    @Test
    fun everyOtherSessionAppOperationsOrWindowFailsTheSameSignature() {
        val v = vectors()
        val pub = HexUtil.decode(v["adminPubHex"]!!.jsonPrimitive.content)!!
        val sig = HexUtil.decode(v["signatureHex"]!!.jsonPrimitive.content)!!
        for (c in v["invalid"]!!.jsonArray) {
            val bytes = CompanionDelegation.canonicalBytes(order(c.jsonObject["delegation"]!!.jsonObject))
            assertEquals(c.jsonObject["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
            assertThrows(GeneralSecurityException::class.java) { Ed25519Verify(pub).verify(sig, bytes) }
        }
    }

    @Test
    fun malformedDelegationsAreRefused() {
        val base = order(vectors()["delegation"]!!.jsonObject)
        for (bad in listOf(
            base.copy(ops = emptyList()),
            base.copy(ops = listOf("root")),
            base.copy(sessionId = "short"),
            base.copy(serviceRef = "a|b"),
            base.copy(expiresAt = base.issuedAt),
        )) {
            assertThrows(IllegalArgumentException::class.java) { CompanionDelegation.canonicalBytes(bad) }
        }
    }
}
