package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ChatApprovalTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/chat-approval/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("vectors.json not found"); throw IllegalStateException()
    }

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun build(o: JsonObject): ByteArray {
        val kind = ChatApproval.Kind.entries.firstOrNull { it.wire == o["kind"]!!.jsonPrimitive.content } ?: throw IllegalArgumentException("kind")
        val decision = ChatApproval.Decision.entries.firstOrNull { it.wire == o["decision"]!!.jsonPrimitive.content } ?: throw IllegalArgumentException("decision")
        return ChatApproval.canonicalBytes(o["serverDomain"]!!.jsonPrimitive.content, o["requestId"]!!.jsonPrimitive.content, kind, decision, o["issuedAt"]!!.jsonPrimitive.long)
    }

    @Test
    fun canonicalBytesAndSignaturesMatchTheSharedVector() {
        val v = vectors()
        val verifier = Ed25519Verify(unhex(v["pubHex"]!!.jsonPrimitive.content))
        for (e in v["orders"]!!.jsonArray) {
            val entry = e.jsonObject
            val bytes = build(entry["order"]!!.jsonObject)
            assertEquals(entry["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
            verifier.verify(unhex(entry["signatureHex"]!!.jsonPrimitive.content), bytes)
        }
    }

    @Test
    fun malformedOrdersAreRefused() {
        for (e in vectors()["refused"]!!.jsonArray) {
            val entry = e.jsonObject
            try {
                build(entry["order"]!!.jsonObject)
                fail(entry["name"]!!.jsonPrimitive.content)
            } catch (_: IllegalArgumentException) {
            }
        }
    }
}
