// KNOWN-ANSWER + body-shape tests for the IRK-signed cloud-recovery
// upload. Canonical bytes + signature MUST stay byte-identical to the
// Worker (canonicalUploadRecoveryRecord in @flagship/protocol +
// handleUploadWebauthnRecovery in control-plane). Pure-JVM.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.RecoveryEnvelopeRequest
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecoveryUploadTest {

    // Vector inputs (shared with the iOS + Worker KATs).
    private val username = "demo1234"
    private val credentialId = "aabbccddeeff00112233445566778899"
    private val wrappedUmkHashHex = "1".repeat(64)
    private val issuedAt = 1_700_000_000_000L

    private fun irk(seedByte: Byte): Pair<Ed25519Sign, String> {
        val seed = ByteArray(32) { seedByte }
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        return Ed25519Sign(seed) to HexUtil.encode(pub)
    }

    @Test
    fun canonicalBytes_matchWorker() {
        val canon = RecoveryUpload.canonicalBytes(
            username = username,
            credentialId = credentialId,
            wrappedUmkHashHex = wrappedUmkHashHex,
            issuedAt = issuedAt,
        )
        val expected =
            "flagship/upload-recovery-record/v1|demo1234|" +
                "aabbccddeeff00112233445566778899|" +
                "1111111111111111111111111111111111111111111111111111111111111111|" +
                "1700000000000"
        assertEquals(expected, String(canon, Charsets.UTF_8))
    }

    @Test
    fun knownAnswer_signatureMatchesLiteral() {
        // IRK seed = 32 bytes 0x03 → pub ed4928…; sig over the canonical
        // above MUST equal the literal the Worker verifies against.
        val (signer, pubHex) = irk(0x03)
        assertEquals(
            "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1",
            pubHex,
        )
        val sig = RecoveryUpload.sign(
            irk = signer,
            username = username,
            credentialId = credentialId,
            wrappedUmkHashHex = wrappedUmkHashHex,
            issuedAt = issuedAt,
        )
        assertEquals(
            "07d47f6e502c2d8e44bd1f4966715e06e56e73b474c2ef47bee357d306b533de" +
                "44f321eeeb3549b56d780566d8ef9658e0e8bded588f8e7e5ac2168da23bef0a",
            HexUtil.encode(sig),
        )
    }

    @Test
    fun wrappedUmkHashHex_isLowercaseSha256OfBytes() {
        // SHA-256 of empty input — stable, well-known digest. Confirms we
        // hash the RAW bytes (the Worker decodes wrappedUmk → bytes first).
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            RecoveryUpload.wrappedUmkHashHex(ByteArray(0)),
        )
    }

    @Test
    fun bodyShape_isSignedNested_withNoNonceField() {
        // The on-wire body must be { request: { username, credentialId,
        // wrappedUmk, issuedAt }, signature } — NO flat nonceBase64 field.
        val (signer, _) = irk(0x03)
        val sig = RecoveryUpload.sign(signer, username, credentialId, wrappedUmkHashHex, issuedAt)
        val req = RecoveryEnvelopeRequest(
            request = RecoveryEnvelopeRequest.Inner(
                username = username,
                credentialId = credentialId,
                wrappedUmk = "QkxPQg==", // opaque base64; not validated here
                issuedAt = issuedAt,
            ),
            signature = HexUtil.encode(sig),
        )
        // Mirror the live transport's Json (OkHttpJsonTransport.defaultJson):
        // encodeDefaults + explicitNulls=false ⇒ null optionals are OMITTED.
        val json = Json { encodeDefaults = true; explicitNulls = false }
            .encodeToString(RecoveryEnvelopeRequest.serializer(), req)
        val obj = Json.parseToJsonElement(json).jsonObject
        val inner = obj["request"]!!.jsonObject
        assertEquals(username, inner["username"]!!.jsonPrimitive.content)
        assertEquals(credentialId, inner["credentialId"]!!.jsonPrimitive.content)
        assertEquals("QkxPQg==", inner["wrappedUmk"]!!.jsonPrimitive.content)
        assertEquals(issuedAt, inner["issuedAt"]!!.jsonPrimitive.content.toLong())
        assertTrue(obj.containsKey("signature"))
        // The flat pre-signed fields must be GONE.
        assertFalse(inner.containsKey("nonceBase64"))
        assertFalse(inner.containsKey("wrappedUmkBase64"))
        // wrappedAcmeAccountKey is omitted (null) when not escrowing.
        assertNull(inner["wrappedAcmeAccountKey"])
    }
}
