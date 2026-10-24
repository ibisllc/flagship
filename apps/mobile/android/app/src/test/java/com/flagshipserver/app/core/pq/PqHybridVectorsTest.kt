package com.flagshipserver.app.core.pq

import com.flagshipserver.app.core.pq.PqVectors.h
import com.flagshipserver.app.core.pq.PqVectors.x
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/pq-hybrid/ (vectors.json and the X-Wing
// draft-11 KATs in xwing-draft11-kats.json); TS, Rust and Swift read the same files.
class PqHybridVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/pq-hybrid/vectors.json")
    private val kats = PqVectors.load("packages/protocol/test-vectors/pq-hybrid/xwing-draft11-kats.json")

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    private fun code(f: () -> Unit): String = try {
        f(); "ok"
    } catch (e: PqHybridException) {
        e.code
    }

    private fun headerFrom(j: JsonObject) = PqHybrid.EnvelopeHeaderV2(
        purpose = j.s("purpose"),
        suite = j["suite"]!!.jsonPrimitive.int,
        senderKeyId = h(j.s("senderKeyId")),
        recipientKeyId = j["recipientKeyId"]?.let { h(it.jsonPrimitive.content) },
        installationId = j["installationId"]?.let { h(it.jsonPrimitive.content) },
        authorityGeneration = j["authorityGeneration"]?.jsonPrimitive?.long,
        sessionNonce = j["sessionNonce"]?.let { h(it.jsonPrimitive.content) },
        policyDigest = j["policyDigest"]?.let { h(it.jsonPrimitive.content) },
        issuedAt = j["issuedAt"]!!.jsonPrimitive.long,
        expiresAt = j["expiresAt"]?.jsonPrimitive?.long,
        bodyLen = j["bodyLen"]!!.jsonPrimitive.long,
    )

    private fun sealOptions(o: JsonObject, purpose: String = o.s("purpose")) = PqHybrid.HybridSealOptions(
        purpose = purpose,
        senderKeyId = h(o.s("senderKeyId")),
        issuedAt = o["issuedAt"]!!.jsonPrimitive.long,
        expiresAt = o["expiresAt"]?.jsonPrimitive?.long,
        installationId = o["installationId"]?.let { h(it.jsonPrimitive.content) },
        authorityGeneration = o["authorityGeneration"]?.jsonPrimitive?.long,
        sessionNonce = o["sessionNonce"]?.let { h(it.jsonPrimitive.content) },
        policyDigest = o["policyDigest"]?.let { h(it.jsonPrimitive.content) },
    )

    private fun ctx(c: JsonObject) = c["context"]!!.jsonArray.map { h(it.jsonPrimitive.content) }

    @Test
    fun xwingDraft11Kats() {
        for (k in kats["vectors"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(k.s("sk"), k.s("seed"))
            val pk = PqHybrid.xwingPublicKey(h(k.s("seed")))
            assertEquals(k.s("pk"), x(pk))
            val (ct, ss) = PqHybrid.xwingEncapsulate(pk, h(k.s("eseed")))
            assertEquals(k.s("ct"), x(ct))
            assertEquals(k.s("ss"), x(ss))
            assertEquals(k.s("ss"), x(PqHybrid.xwingDecapsulate(ct, h(k.s("seed")))))
        }
    }

    @Test
    fun keyIdsAndRawKem() {
        for (k in v["keyIds"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(k.s("keyId"), x(PqHybrid.pqKeyId(k["suite"]!!.jsonPrimitive.int, h(k.s("publicKey")))))
        }
        for (k in v["kem"]!!.jsonArray.map { it.jsonObject }) {
            val pk = PqHybrid.xwingPublicKey(h(k.s("seed")))
            assertEquals(k.s("publicKey"), x(pk))
            val (enc, ss) = PqHybrid.xwingEncapsulate(pk, h(k.s("eseed")))
            assertEquals(k.s("enc"), x(enc))
            assertEquals(k.s("sharedSecret"), x(ss))
            assertEquals(k.s("sharedSecret"), x(PqHybrid.xwingDecapsulate(enc, h(k.s("seed")))))
        }
    }

    @Test
    fun envelopeHeaders() {
        val env = v["envelope"]!!.jsonObject
        for (c in env["valid"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(c.s("hex"), x(PqHybrid.encodeEnvelopeHeader(headerFrom(c["header"]!!.jsonObject))))
            val d = PqHybrid.decodeEnvelopeHeader(h(c.s("hex")))
            assertEquals(c.s("hex").length / 2, d.length)
            assertEquals(c.s("hex"), x(PqHybrid.encodeEnvelopeHeader(d.header)))
        }
        val invalid = env["invalid"]!!.jsonArray.map { it.jsonObject }
        assertEquals(21, invalid.size)
        for (c in invalid) assertEquals(c.s("name"), c.s("expect"), code { PqHybrid.decodeEnvelopeHeader(h(c.s("hex"))) })
    }

    @Test
    fun sealDeterministicAndRoundTrip() {
        val seal = v["seal"]!!.jsonObject
        for (c in seal["valid"]!!.jsonArray.map { it.jsonObject }) {
            val kp = PqHybrid.hybridSealKeygen(h(c.s("recipientSeed")))
            assertEquals(c.s("recipientPublicKey"), x(kp.publicKey))
            val o = c["options"]!!.jsonObject
            val sealed = PqHybrid.hybridSealWithRandomness(kp.publicKey, sealOptions(o), ctx(c), h(c.s("plaintext")), h(c.s("eseed")))
            assertEquals(c.s("name"), c.s("sealed"), x(sealed))
            val opened = PqHybrid.hybridOpen(kp.secretKey, o.s("purpose"), ctx(c), h(c.s("sealed")))
            assertEquals(c.s("plaintext"), x(opened.plaintext))
            assertEquals(o.s("senderKeyId"), x(opened.header.senderKeyId))
        }
        val c = seal["valid"]!!.jsonArray[0].jsonObject
        val kp = PqHybrid.hybridSealKeygen(h(c.s("recipientSeed")))
        val o = c["options"]!!.jsonObject
        val a = PqHybrid.hybridSeal(kp.publicKey, sealOptions(o), ctx(c), h(c.s("plaintext")))
        val b = PqHybrid.hybridSeal(kp.publicKey, sealOptions(o), ctx(c), h(c.s("plaintext")))
        assertNotEquals(x(a), x(b))
        assertEquals(c.s("plaintext"), x(PqHybrid.hybridOpen(kp.secretKey, o.s("purpose"), ctx(c), a).plaintext))
    }

    @Test
    fun openRefusesEveryInvalidSeal() {
        val invalid = v["seal"]!!.jsonObject["invalid"]!!.jsonArray.map { it.jsonObject }
        assertEquals(24, invalid.size)
        for (c in invalid) {
            assertEquals(c.s("name"), c.s("expect"), code {
                PqHybrid.hybridOpen(h(c.s("recipientSeed")), c.s("expectedPurpose"), ctx(c), h(c.s("sealed")))
            })
        }
    }

    @Test
    fun sealRefusesBadKeysAndInputs() {
        val seal = v["seal"]!!.jsonObject
        for (c in seal["rejectPublicKeys"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(c.s("name"), c.s("expect"), code { PqHybrid.parseHybridSealPublicKey(h(c.s("publicKey"))) })
        }
        val base = seal["valid"]!!.jsonArray[0].jsonObject
        for (c in seal["rejectInputs"]!!.jsonArray.map { it.jsonObject }) {
            val opts = sealOptions(base["options"]!!.jsonObject, purpose = c.s("purpose"))
            val context = List(c["contextFields"]!!.jsonPrimitive.int) { ByteArray(0) }
            val pt = ByteArray(c["plaintextLen"]!!.jsonPrimitive.int)
            assertEquals(c.s("name"), c.s("expect"), code {
                PqHybrid.hybridSealWithRandomness(h(base.s("recipientPublicKey")), opts, context, pt, h(base.s("eseed")))
            })
        }
    }

    @Test
    fun signaturesReproduceAndVerify() {
        val sig = v["sig"]!!.jsonObject
        for (c in sig["valid"]!!.jsonArray.map { it.jsonObject }) {
            val kp = PqHybrid.hybridSigKeygen(h(c.s("edSeed")), h(c.s("mldsaSeed")))
            assertEquals(c.s("publicKey"), x(kp.publicKey))
            assertEquals(c.s("keyId"), x(PqHybrid.pqKeyId(2, kp.publicKey)))
            assertEquals(c.s("messageSha512"), x(PqHybrid.sha512(PqHybrid.hybridSigMessage(kp.publicKey, c.s("purpose"), h(c.s("payload"))))))
            assertEquals(c.s("name"), c.s("signature"), x(PqHybrid.hybridSign(kp.secretKey, c.s("purpose"), h(c.s("payload")), deterministic = true)))
            assertEquals("ok", code { PqHybrid.hybridVerify(kp.publicKey, c.s("purpose"), h(c.s("payload")), h(c.s("signature"))) })
            val hedged = PqHybrid.hybridSign(kp.secretKey, c.s("purpose"), h(c.s("payload")))
            assertEquals("ok", code { PqHybrid.hybridVerify(kp.publicKey, c.s("purpose"), h(c.s("payload")), hedged) })
            val edSeed = h(c.s("edSeed"))
            val split = PqHybrid.hybridSignSplit(kp.publicKey.copyOfRange(0, 32), { m -> PqHybrid.ed25519Sign(edSeed, m) }, h(c.s("mldsaSeed")), c.s("purpose"), h(c.s("payload")))
            assertEquals("ok", code { PqHybrid.hybridVerify(kp.publicKey, c.s("purpose"), h(c.s("payload")), split) })
        }
    }

    @Test
    fun verifyRefusesEveryInvalidSignature() {
        val sig = v["sig"]!!.jsonObject
        val invalid = sig["invalid"]!!.jsonArray.map { it.jsonObject }
        assertEquals(18, invalid.size)
        for (c in invalid) {
            assertEquals(c.s("name"), c.s("expect"), code {
                PqHybrid.hybridVerify(h(c.s("publicKey")), c.s("purpose"), h(c.s("payload")), h(c.s("signature")))
            })
        }
        val big = sig["payloadTooLarge"]!!.jsonObject
        assertEquals(big.s("expect"), code {
            PqHybrid.hybridVerify(h(big.s("publicKey")), big.s("purpose"), ByteArray(big["payloadLen"]!!.jsonPrimitive.int), h(big.s("signature")))
        })
    }

    @Test
    fun aStrippedComponentNeverVerifiesAsClassical() {
        val s = v["sig"]!!.jsonObject["classicalStrip"]!!.jsonObject
        val pk = h(s.s("publicKeyEd25519"))
        val edSig = h(s.s("signatureEd25519"))
        assertTrue(PqHybrid.ed25519VerifyStrict(edSig, h(s.s("signedMessage")), pk))
        for (m in s["mustNotVerifyOver"]!!.jsonArray.map { it.jsonObject }) {
            assertFalse(m.s("name"), PqHybrid.ed25519VerifyStrict(edSig, h(m.s("message")), pk))
        }
        assertTrue(s["mldsaMustNotVerifyWithEmptyContext"]!!.jsonPrimitive.boolean)
        val c = v["sig"]!!.jsonObject["valid"]!!.jsonArray[1].jsonObject
        val full = h(c.s("signature"))
        val mlPk = h(c.s("publicKey")).copyOfRange(32, PqHybrid.HYBRID_SIG_PUBLIC_KEY_LEN)
        val m = PqHybrid.hybridSigMessage(h(c.s("publicKey")), c.s("purpose"), h(c.s("payload")))
        val mlSig = full.copyOfRange(64, full.size)
        val tag = PqHybrid.TAG_HYBRID_SIG_ED25519_MLDSA65_V1.toByteArray()
        assertTrue(PqHybrid.mldsa65Verify(mlPk, m, mlSig, tag))
        assertFalse(PqHybrid.mldsa65Verify(mlPk, m, mlSig, ByteArray(0)))
        assertFalse(PqHybrid.mldsa65Verify(mlPk, h(c.s("payload")), mlSig, tag))
    }
}
