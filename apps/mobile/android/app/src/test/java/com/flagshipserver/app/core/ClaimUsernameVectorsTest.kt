// Runs packages/protocol/test-vectors/claim-username/vectors.json, read from disk so a drift fails here: the IRK signs
// flagship/claim-username/v2, which binds the AID and admin-root keys the claim carries.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ClaimUsernameVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/claim-username/vectors.json"
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

    private fun opt(e: JsonElement?): String? = if (e == null || e is JsonNull) null else e.jsonPrimitive.content

    private fun bytes(c: JsonObject): ByteArray {
        val r = c["request"]!!.jsonObject
        return UsernameClaim.canonicalBytes(
            username = r["username"]!!.jsonPrimitive.content,
            irkPubHex = r["irkPub"]!!.jsonPrimitive.content,
            aidPubHex = opt(c["aidPub"]),
            adminRootPubHex = opt(c["adminRootPub"]),
            issuedAt = r["issuedAt"]!!.jsonPrimitive.long,
        )
    }

    private fun verifies(c: JsonObject, msg: ByteArray): Boolean {
        val pub = HexUtil.decode(c["request"]!!.jsonObject["irkPub"]!!.jsonPrimitive.content)!!
        return runCatching {
            Ed25519Verify(pub).verify(HexUtil.decode(c["signatureHex"]!!.jsonPrimitive.content)!!, msg)
        }.isSuccess
    }

    @Test fun acceptCasesSignAndVerify() {
        val irk = Ed25519Sign(HexUtil.decode(root["keys"]!!.jsonObject["irkSeedHex"]!!.jsonPrimitive.content)!!)
        for (e in root["accept"]!!.jsonArray) {
            val c = e.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val msg = bytes(c)
            assertEquals(name, c["canonical"]!!.jsonPrimitive.content, String(msg))
            assertEquals(name, c["signatureHex"]!!.jsonPrimitive.content, HexUtil.encode(irk.sign(msg)))
            assertTrue(name, verifies(c, msg))
        }
    }

    @Test fun rejectCasesFail() {
        for (e in root["reject"]!!.jsonArray) {
            val c = e.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val msg = bytes(c)
            assertEquals(name, c["canonical"]!!.jsonPrimitive.content, String(msg))
            assertFalse(name, verifies(c, msg))
        }
    }
}
