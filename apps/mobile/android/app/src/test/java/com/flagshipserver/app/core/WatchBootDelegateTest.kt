package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify
import com.google.crypto.tink.subtle.X25519
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class WatchBootDelegateTest {
    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/watch-boot-delegate/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("vectors.json not found"); throw IllegalStateException()
    }

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun att(o: JsonObject) = WatchBootDelegate.Attestation(
        o["serverDomain"]!!.jsonPrimitive.content, o["delegatePubHex"]!!.jsonPrimitive.content,
        o["decryptPubHex"]!!.jsonPrimitive.content, o["keySha256Hex"]!!.jsonPrimitive.content,
        o["issuedAt"]!!.jsonPrimitive.long, o["expiresAt"]!!.jsonPrimitive.long,
    )

    @Test
    fun canonicalBytesSignatureAndSealedCopyMatchTheSharedVector() {
        val v = vectors()
        val dep = v["deposit"]!!.jsonObject
        val a = att(dep)
        val bytes = WatchBootDelegate.canonicalBytes(a)
        assertEquals(v["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
        Ed25519Verify(unhex(v["accountPubHex"]!!.jsonPrimitive.content))
            .verify(unhex(dep["signatureHex"]!!.jsonPrimitive.content), bytes)
        val d = WatchBootDelegate.Deposit(a, dep["sealedKeyHex"]!!.jsonPrimitive.content, dep["signatureHex"]!!.jsonPrimitive.content)
        assertArrayEquals(unhex(v["diskKeyHex"]!!.jsonPrimitive.content), WatchBootDelegate.openKey(d, unhex(v["decryptPrivHex"]!!.jsonPrimitive.content)))
    }

    @Test
    fun everyOtherServerWatchKeyDigestOrWindowFailsTheSameSignature() {
        val v = vectors()
        val verifier = Ed25519Verify(unhex(v["accountPubHex"]!!.jsonPrimitive.content))
        val sig = unhex(v["deposit"]!!.jsonObject["signatureHex"]!!.jsonPrimitive.content)
        for (bad in v["invalid"]!!.jsonArray) {
            val o = bad.jsonObject
            val bytes = WatchBootDelegate.canonicalBytes(att(o["delegate"]!!.jsonObject))
            assertEquals(o["name"]!!.jsonPrimitive.content, o["canonical"]!!.jsonPrimitive.content, String(bytes, Charsets.UTF_8))
            var ok = true
            try { verifier.verify(sig, bytes) } catch (_: java.security.GeneralSecurityException) { ok = false }
            assertFalse(o["name"]!!.jsonPrimitive.content, ok)
        }
    }

    @Test
    fun aBuiltDepositOpensWithTheMatchingKeyOnlyAndALongerWindowIsRefused() {
        val priv = X25519.generatePrivateKey()
        val pub = X25519.publicFromPrivate(priv)
        val disk = ByteArray(32) { 0x42 }
        val watch = ByteArray(32) { 7 }
        val d = WatchBootDelegate.build("Kitchen.Alice.flagship.services", disk, watch, pub, 1_000, 61_000) { ByteArray(64) }
        assertEquals("kitchen.alice.flagship.services", d.attestation.serverDomain)
        assertArrayEquals(disk, WatchBootDelegate.openKey(d, priv))
        assertNull(WatchBootDelegate.openKey(d, X25519.generatePrivateKey()))
        try {
            WatchBootDelegate.build("k.a.flagship.services", disk, watch, pub, 0, WatchBootDelegate.MAX_MS + 1) { ByteArray(64) }
            fail("window")
        } catch (_: IllegalArgumentException) {
        }
    }
}
