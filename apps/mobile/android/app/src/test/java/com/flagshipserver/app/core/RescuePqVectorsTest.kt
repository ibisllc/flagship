package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.AssurancePolicy
import com.flagshipserver.app.core.pq.PqTrust
import com.flagshipserver.app.core.pq.PqTrustException
import com.flagshipserver.app.core.pq.PqVectors
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
import org.junit.Assert.assertNull
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/rescue/pq-vectors.json: the hybrid half of the
// rescue session, every offline-control order and the box's hello, through the same gate as every
// other critical signature (19 cases), plus the phone's own hello check (Rescue.checkHelloPq).
class RescuePqVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/rescue/pq-vectors.json")

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    private fun code(f: () -> Unit): String = try {
        f(); "ok"
    } catch (e: PqTrustException) {
        e.code
    }

    private val valid get() = v["bindings"]!!.jsonObject["valid"]!!.jsonArray.map { it.jsonObject }
    private val gate get() = v["gate"]!!.jsonArray.map { it.jsonObject }

    private fun binding(c: JsonObject): PqTrust.VerifiedBinding? {
        val name = c["binding"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content ?: return null
        val vb = valid.first { it.s("name") == name }
        val e = vb["expect"]!!.jsonObject
        return PqTrust.verifyPqKeyBinding(
            vb["wire"],
            PqTrust.Expectation(
                role = e.s("role"), subjectId = e.s("subjectId"), ed25519PubHex = e.s("ed25519PubHex"),
                mldsaPubHex = e["mldsaPubHex"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content,
                now = e["now"]!!.jsonPrimitive.long, minIssuedAt = e["minIssuedAt"]?.jsonPrimitive?.longOrNull,
            ),
        )
    }

    private fun exchange(): Rescue.Exchange {
        val e = v["exchange"]!!.jsonObject
        return Rescue.Exchange(e.s("serverDomain"), e.s("clientNonce"), e.s("boxNonce"), e.s("certSha256"), e["issuedAt"]!!.jsonPrimitive.long)
    }

    @Test
    fun messagesAreOurCanonicalBytes() {
        val ex = exchange()
        val o = v["controlOrder"]!!.jsonObject
        val order = Rescue.ControlOrder(o.s("serverDomain"), o.s("sessionNonce"), o.s("action"), o.s("target"), o.s("nonce"), o["issuedAt"]!!.jsonPrimitive.long)
        val known = mapOf(
            Rescue.SESSION_TAG to x(ex.sessionCanonical()),
            Rescue.HELLO_TAG to x(ex.helloCanonical()),
            Rescue.CONTROL_TAG to x(order.canonical()),
        )
        for (c in gate.filter { it.s("name").endsWith("-strict-hybrid") && !it.s("name").contains("shutdown") }) {
            assertEquals(c.s("name"), known[c.s("expectedPurpose")], c.s("messageHex"))
        }
    }

    @Test
    fun gateCases() {
        assertEquals(19, gate.size)
        for (c in gate) {
            val env = c["envelope"]!!.jsonObject
            val expect = c["expect"]!!.jsonObject
            val p = c["policy"]!!.jsonObject
            val policy = AssurancePolicy.legacyState(AssurancePolicy.Scope("installation", "home.alice.flagship.services"))
                .copy(profile = p.s("profile"), rollout = p.s("rollout"))
            var verdict: PqTrust.Verdict? = null
            val got = code {
                verdict = PqTrust.verifyCriticalSignature(
                    message = h(c.s("messageHex")), expectedPurpose = c.s("expectedPurpose"),
                    envelope = PqTrust.SignatureEnvelope(env.s("suite"), env.s("signature")),
                    signerEd25519PubHex = c.s("signerEd25519PubHex"), binding = binding(c), policy = policy,
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
    fun theHelloCheckAgreesWithTheVectors() {
        val ex = exchange()
        for (c in gate.filter { it.s("expectedPurpose") == Rescue.HELLO_TAG }) {
            val b = binding(c)
            val env = c["envelope"]!!.jsonObject
            val strict = c["policy"]!!.jsonObject.s("profile") == "strict"
            val classical = env.s("suite") == "ed25519/v1"
            val refusal = Rescue.checkHelloPq(
                ex, if (classical) null else env.s("suite"), if (classical) null else env.s("signature"),
                c.s("signerEd25519PubHex"), b?.mldsaPubHex, strict,
            )
            val expect = c["expect"]!!.jsonObject
            if (expect["ok"]!!.jsonPrimitive.boolean) assertNull(c.s("name"), refusal)
            else assertEquals(c.s("name"), if (expect.s("code") == "strict-requires-hybrid") "strict-requires-hybrid" else "bad-signature", refusal)
        }
    }
}
