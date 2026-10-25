package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class BrowserGrantTest {
    private fun vectors(rel: String = "packages/protocol/test-vectors/browser-grant/vectors.json"): JsonObject {
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("vectors.json not found"); throw IllegalStateException()
    }

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun build(a: JsonObject): ByteArray {
        val lan = a["localNetwork"]
        val lanObj = if (lan == null || lan is JsonNull) null else lan.jsonObject
        val whole = lanObj?.get("kind")?.jsonPrimitive?.content == "whole-lan"
        val exact = if (lanObj != null && !whole) lanObj["hosts"]!!.jsonArray.map { it.jsonPrimitive.content } else null
        return BrowserGrant.canonicalBytes(
            a["serverDomain"]!!.jsonPrimitive.content, a["requestId"]!!.jsonPrimitive.content, a["serviceId"]!!.jsonPrimitive.content,
            a["decision"]!!.jsonPrimitive.content, a["duration"]!!.jsonPrimitive.content,
            a["capabilities"]!!.jsonArray.map { it.jsonPrimitive.content }, a["origins"]!!.jsonArray.map { it.jsonPrimitive.content },
            exact, whole, a["issuedAt"]!!.jsonPrimitive.long,
        )
    }

    @Test
    fun canonicalBytesAndSignaturesMatchTheSharedVector() {
        val v = vectors()
        val verifier = Ed25519Verify(unhex(v["pubHex"]!!.jsonPrimitive.content))
        for (e in v["answers"]!!.jsonArray) {
            val bytes = build(e.jsonObject["answer"]!!.jsonObject)
            assertEquals(e.jsonObject["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
            verifier.verify(unhex(e.jsonObject["signatureHex"]!!.jsonPrimitive.content), bytes)
        }
        for (e in v["refused"]!!.jsonArray) {
            try {
                build(e.jsonObject["answer"]!!.jsonObject)
                fail(e.jsonObject["name"]!!.jsonPrimitive.content)
            } catch (_: IllegalArgumentException) {
            }
        }
    }

    private fun scope(o: JsonObject): BrowserGrant.Scope {
        val lan = o["localNetwork"]
        val lanObj = if (lan == null || lan is JsonNull) null else lan.jsonObject
        val whole = lanObj?.get("kind")?.jsonPrimitive?.content == "whole-lan"
        return BrowserGrant.Scope(
            duration = o["duration"]!!.jsonPrimitive.content,
            capabilities = o["capabilities"]!!.jsonArray.map { it.jsonPrimitive.content },
            origins = o["origins"]!!.jsonArray.map { it.jsonPrimitive.content },
            exactHosts = if (lanObj != null && !whole) lanObj["hosts"]!!.jsonArray.map { it.jsonPrimitive.content } else null,
            wholeLan = whole,
        )
    }

    @Test
    fun narrowingMatchesTheSharedVector() {
        val v = vectors()
        for (e in v["narrowing"]!!.jsonArray) {
            val o = e.jsonObject
            assertEquals(o["name"]!!.jsonPrimitive.content, o["within"]!!.jsonPrimitive.content.toBoolean(), BrowserGrant.within(scope(o["ask"]!!.jsonObject), scope(o["answer"]!!.jsonObject)))
        }
        for (e in v["choices"]!!.jsonArray) {
            val o = e.jsonObject
            assertEquals(o["choices"]!!.jsonArray.map { it.jsonPrimitive.content }, BrowserGrant.durationChoices(o["asked"]!!.jsonPrimitive.content))
        }
        assertEquals(emptyList<String>(), BrowserGrant.durationChoices("forever"))
    }

    @Test
    fun revokeBytesAndSignaturesMatchTheSharedVector() {
        val v = vectors("packages/protocol/test-vectors/browser-grant-revoke/vectors.json")
        val verifier = Ed25519Verify(unhex(v["pubHex"]!!.jsonPrimitive.content))
        fun build(r: JsonObject) = BrowserGrant.revokeCanonicalBytes(
            r["serverDomain"]!!.jsonPrimitive.content, r["serviceId"]!!.jsonPrimitive.content,
            r["grantId"]!!.jsonPrimitive.content, r["issuedAt"]!!.jsonPrimitive.long,
        )
        for (e in v["revokes"]!!.jsonArray) {
            val bytes = build(e.jsonObject["revoke"]!!.jsonObject)
            assertEquals(e.jsonObject["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
            verifier.verify(unhex(e.jsonObject["signatureHex"]!!.jsonPrimitive.content), bytes)
        }
        for (e in v["refused"]!!.jsonArray) {
            try {
                build(e.jsonObject["revoke"]!!.jsonObject)
                fail(e.jsonObject["name"]!!.jsonPrimitive.content)
            } catch (_: IllegalArgumentException) {
            }
        }
    }
}
