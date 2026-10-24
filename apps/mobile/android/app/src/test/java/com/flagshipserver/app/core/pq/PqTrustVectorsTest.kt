package com.flagshipserver.app.core.pq

import com.flagshipserver.app.core.pq.PqVectors.h
import com.flagshipserver.app.core.pq.PqVectors.x
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/pq-binding/vectors.json (5 valid bindings,
// 31 refusals, 27 gate cases) and test-vectors/assurance-policy/vectors.json.
class PqTrustVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/pq-binding/vectors.json")
    private val policyVectors = PqVectors.load("packages/protocol/test-vectors/assurance-policy/vectors.json")

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    private fun code(f: () -> Unit): String = try {
        f(); "ok"
    } catch (e: PqTrustException) {
        e.code
    }

    private fun expectation(e: JsonObject) = PqTrust.Expectation(
        role = e.s("role"),
        subjectId = e.s("subjectId"),
        ed25519PubHex = e.s("ed25519PubHex"),
        mldsaPubHex = e["mldsaPubHex"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content,
        now = e["now"]!!.jsonPrimitive.long,
        minIssuedAt = e["minIssuedAt"]?.jsonPrimitive?.longOrNull,
    )

    private fun policy(p: JsonObject) = AssurancePolicy.legacyState(AssurancePolicy.Scope("installation", "home.alice.flagship.services"))
        .copy(profile = p.s("profile"), rollout = p.s("rollout"))

    private val valid get() = v["bindings"]!!.jsonObject["valid"]!!.jsonArray.map { it.jsonObject }

    private fun secret(name: String): ByteArray {
        val s = v["signers"]!!.jsonArray.map { it.jsonObject }.first { it.s("name") == name }
        return h(s.s("edSeedHex") + s.s("mldsaSeedHex"))
    }

    @Test
    fun validBindingsVerify() {
        assertEquals(5, valid.size)
        for (c in valid) {
            val w = PqTrust.pqKeyBindingFromWire(c["wire"])
            assertEquals(c.s("statementHex"), x(PqTrust.canonicalPqKeyBinding(w.statement)))
            val b = PqTrust.verifyPqKeyBinding(c["wire"], expectation(c["expect"]!!.jsonObject))
            assertEquals(w.mldsaPubHex, b.mldsaPubHex)
        }
    }

    @Test
    fun invalidBindingsAreRefusedWithTheirCodes() {
        val invalid = v["bindings"]!!.jsonObject["invalid"]!!.jsonArray.map { it.jsonObject }
        assertEquals(31, invalid.size)
        for (c in invalid) {
            assertEquals(c.s("name"), c.s("code"), code { PqTrust.verifyPqKeyBinding(c["wire"], expectation(c["expect"]!!.jsonObject)) })
        }
    }

    @Test
    fun signsABindingByteForByte() {
        val c = valid.first { it.s("name") == "box-stk" }
        val w = PqTrust.pqKeyBindingFromWire(c["wire"])
        val sk = secret("A")
        val signed = PqTrust.signPqKeyBinding(w.statement) { m -> PqHybrid.hybridSign(sk, PqTrust.messagePurpose(m), m, deterministic = true) }
        assertEquals(c["wire"], signed.toJson())
    }

    @Test
    fun gateCases() {
        val gate = v["gate"]!!.jsonArray.map { it.jsonObject }
        assertEquals(27, gate.size)
        for (c in gate) {
            val bindingName = c["binding"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
            val vb = valid.firstOrNull { it.s("name") == bindingName }
            val binding = vb?.let { PqTrust.verifyPqKeyBinding(it["wire"], expectation(it["expect"]!!.jsonObject)) }
            val env = c["envelope"]!!.jsonObject
            val expect = c["expect"]!!.jsonObject
            var verdict: PqTrust.Verdict? = null
            val got = code {
                verdict = PqTrust.verifyCriticalSignature(
                    message = h(c.s("messageHex")),
                    expectedPurpose = c.s("expectedPurpose"),
                    envelope = PqTrust.SignatureEnvelope(env.s("suite"), env.s("signature")),
                    signerEd25519PubHex = c.s("signerEd25519PubHex"),
                    binding = binding,
                    policy = policy(c["policy"]!!.jsonObject),
                )
            }
            if (expect["ok"]!!.jsonPrimitive.boolean) {
                assertEquals(c.s("name"), "ok", got)
                assertEquals(c.s("name"), PqTrust.Verdict(expect.s("suite"), expect["strict"]!!.jsonPrimitive.boolean), verdict)
            } else {
                assertEquals(c.s("name"), expect.s("code"), got)
            }
        }
    }

    @Test
    fun bootKeyBindingV2UnderThePinnedKeys() {
        val c = valid.first { it.s("name") == "box-stk" }
        val w = PqTrust.pqKeyBindingFromWire(c["wire"])
        val sk = secret("A")
        val boot = v["signers"]!!.jsonArray[1].jsonObject.s("ed25519PubHex")
        val msg = BoxPqKeyPin.canonicalBootKeyBindingV2(w.subjectId, boot, 5)
        val sig = x(PqHybrid.hybridSign(sk, BoxPqKeyPin.TAG_BOOT_KEY_BINDING_V2, msg))
        assertTrue(BoxPqKeyPin.verifyBootKeyBindingV2(w.subjectId, boot, 5, sig, w.ed25519PubHex, w.mldsaPubHex))
        assertFalse(BoxPqKeyPin.verifyBootKeyBindingV2(w.subjectId, boot, 6, sig, w.ed25519PubHex, w.mldsaPubHex))
        assertFalse(BoxPqKeyPin.verifyBootKeyBindingV2(w.subjectId, boot, 5, null, w.ed25519PubHex, w.mldsaPubHex))
        val other = PqTrust.pqKeyBindingFromWire(valid.first { it.s("name") != "box-stk" && it["wire"]!!.jsonObject.s("ed25519PubHex") != w.ed25519PubHex }["wire"])
        assertFalse(BoxPqKeyPin.verifyBootKeyBindingV2(w.subjectId, boot, 5, sig, w.ed25519PubHex, other.mldsaPubHex))
    }

    @Test
    fun boxPqPinFirstMatchAndChange() {
        val c = valid.first { it.s("name") == "box-stk" }
        val w = PqTrust.pqKeyBindingFromWire(c["wire"])
        val now = v["now"]!!.jsonPrimitive.long
        val first = BoxPqKeyPin.decide(w.ed25519PubHex, null, null, w.subjectId, c["wire"], now)
        assertEquals(BoxPqKeyPin.Verdict.Pinned(true, w.mldsaPubHex, w.issuedAt), first)
        val again = BoxPqKeyPin.decide(w.ed25519PubHex, w.mldsaPubHex, w.issuedAt, w.subjectId, c["wire"], now)
        assertEquals(BoxPqKeyPin.Verdict.Pinned(false, w.mldsaPubHex, w.issuedAt), again)
        val other = valid.first { it["wire"]!!.jsonObject.s("mldsaPubHex") != w.mldsaPubHex }
        val changed = BoxPqKeyPin.decide(w.ed25519PubHex, other["wire"]!!.jsonObject.s("mldsaPubHex"), null, w.subjectId, c["wire"], now)
        assertTrue(changed is BoxPqKeyPin.Verdict.Mismatch)
        val wrongStk = BoxPqKeyPin.decide("00".repeat(32), null, null, w.subjectId, c["wire"], now)
        assertEquals(BoxPqKeyPin.Verdict.Invalid("binding-key-mismatch"), wrongStk)
    }

    @Test
    fun assurancePolicyCanonicalBytesAndDigests() {
        assertEquals(AssurancePolicy.TAG_ASSURANCE_POLICY, policyVectors.s("tag"))
        val cases = policyVectors["cases"]!!.jsonArray.map { it.jsonObject }
        assertEquals(3, cases.size)
        for (c in cases) {
            val change = AssurancePolicyWire.changeFromJson(c["change"]!!.jsonObject)
            assertEquals(c.s("name"), c.s("canonical"), String(AssurancePolicy.canonical(change), Charsets.UTF_8))
            assertEquals(c.s("name"), c.s("digest"), AssurancePolicy.digest(change))
            assertEquals(c["change"], AssurancePolicyWire.changeToJson(change))
        }
    }
}
