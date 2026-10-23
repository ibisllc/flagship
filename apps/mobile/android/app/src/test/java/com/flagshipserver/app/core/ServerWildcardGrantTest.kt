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
import java.security.GeneralSecurityException

class ServerWildcardGrantTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/server-wildcard-grant/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("vectors.json not found"); throw IllegalStateException()
    }

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun build(g: JsonObject) = ServerWildcardGrant.canonicalBytes(
        g["username"]!!.jsonPrimitive.content, g["serverDomain"]!!.jsonPrimitive.content,
        g["stkPubHex"]!!.jsonPrimitive.content, g["issuedAt"]!!.jsonPrimitive.long,
    )

    @Test
    fun canonicalBytesAndSignaturesMatchTheSharedVector() {
        val v = vectors()
        val verifier = Ed25519Verify(unhex(v["pubHex"]!!.jsonPrimitive.content))
        val grants = v["grants"]!!.jsonArray
        for (e in grants) {
            val entry = e.jsonObject
            val bytes = build(entry["grant"]!!.jsonObject)
            assertEquals(entry["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
            verifier.verify(unhex(entry["signatureHex"]!!.jsonPrimitive.content), bytes)
        }
        val firstSig = unhex(grants[0].jsonObject["signatureHex"]!!.jsonPrimitive.content)
        for (e in v["invalid"]!!.jsonArray) {
            val entry = e.jsonObject
            try {
                verifier.verify(firstSig, build(entry["grant"]!!.jsonObject))
                fail(entry["name"]!!.jsonPrimitive.content)
            } catch (_: GeneralSecurityException) {
            }
        }
    }

    @Test
    fun malformedGrantsAreRefused() {
        for (e in vectors()["refused"]!!.jsonArray) {
            val entry = e.jsonObject
            try {
                build(entry["grant"]!!.jsonObject)
                fail(entry["name"]!!.jsonPrimitive.content)
            } catch (_: IllegalArgumentException) {
            }
        }
    }
}
