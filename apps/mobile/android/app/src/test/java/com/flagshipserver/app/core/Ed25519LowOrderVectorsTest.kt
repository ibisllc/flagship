// Runs packages/protocol/test-vectors/ed25519-low-order/vectors.json: every app-side Ed25519 verify
// (CheckedEd25519Verify, and the helpers built on it) refuses small-order and non-canonical keys
// before the signature is checked, while the honest key still verifies.

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class Ed25519LowOrderVectorsTest {

    private val v: JsonObject by lazy {
        val rel = "packages/protocol/test-vectors/ed25519-low-order/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return@lazy Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private fun b(hex: String) = HexUtil.decode(hex)!!
    private fun checked(pub: ByteArray, sig: ByteArray, msg: ByteArray) =
        try { CheckedEd25519Verify(pub).verify(sig, msg); true } catch (_: Exception) { false }

    private val rejects get() = v["rejectPublicKeysHex"]!!.jsonArray.map { it.jsonPrimitive.content }
    private val messages get() = v["messagesHex"]!!.jsonArray.map { it.jsonPrimitive.content }
    private val forged get() = v["forgedSignatureHex"]!!.jsonPrimitive.content
    private val honest get() = v["honest"]!!.jsonObject

    @Test fun everyVectorKeyIsRefusedAndTheHonestOneAccepted() {
        for (k in rejects) {
            assertFalse(k, Ed25519Keys.isAcceptable(b(k)))
            assertFalse(k, Ed25519Keys.isAcceptableHex(k))
        }
        assertTrue(Ed25519Keys.isAcceptableHex(honest["publicKeyHex"]!!.jsonPrimitive.content))
    }

    @Test fun theForgedSignatureVerifiesUnderNoVectorKey() {
        for (k in rejects) for (m in messages) {
            assertFalse("$k $m", checked(b(k), b(forged), b(m)))
            assertFalse("$k $m", MaintainersEd25519.verify(forged, b(m), k))
            assertFalse("$k $m", Rescue.verifyEd25519(b(k), b(forged), b(m)))
        }
    }

    @Test fun theHonestKeyStillVerifies() {
        val pub = honest["publicKeyHex"]!!.jsonPrimitive.content
        for (s in honest["signatures"]!!.jsonArray) {
            val o = s.jsonObject
            val msg = b(o["messageHex"]!!.jsonPrimitive.content)
            val sig = o["signatureHex"]!!.jsonPrimitive.content
            assertTrue(checked(b(pub), b(sig), msg))
            assertTrue(MaintainersEd25519.verify(sig, msg, pub))
            assertTrue(Rescue.verifyEd25519(b(pub), b(sig), msg))
        }
    }
}
