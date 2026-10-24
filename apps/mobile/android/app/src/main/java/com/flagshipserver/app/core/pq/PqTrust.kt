package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Hybrid key bindings and the critical-signature gate, the Kotlin twin of
 * packages/protocol/src/pqTrust.ts (spec: docs/architecture-v2/pq-suites.md §9-§10; vectors:
 * packages/protocol/test-vectors/pq-binding/). DRAFT, pending Q01 external review.
 *
 * Binding: an identity's Ed25519 key and its ML-DSA-65 key sign
 *   flagship/pq-key-binding/v1|<role>|<subjectId>|<ed25519PubHex>|<mldsa65PubHex>|<issuedAt>
 * together with the hybrid suite, so each proves possession for the other.
 *
 * Gate ([verifyCriticalSignature]): while a scope's strict profile is in force a critical
 * message needs the hybrid AND-signature over a bound key; the policy, never the envelope,
 * decides, so stripping the hybrid suite cannot downgrade a strict scope.
 */
class PqTrustException(val code: String) : Exception(code)

object PqTrust {
    const val TAG_PQ_KEY_BINDING = "flagship/pq-key-binding/v1"
    val ROLES = listOf("account-irk", "admin-root", "device", "box-stk", "boot-key")
    const val MAX_SKEW_MS = 5 * 60 * 1000L
    const val ED25519_SIG_LEN = 64
    private const val MLDSA65_PK_HEX_LEN = 1952 * 2
    const val SUITE_ED25519 = "ed25519/v1"
    const val SUITE_HYBRID = "hybrid-ed25519-mldsa65/v1"

    private val SUBJECT = Regex("^[a-z0-9][a-z0-9._:@-]{0,252}$")
    private val HEX32 = Regex("^[0-9a-f]{64}$")
    private val HEX_MLDSA = Regex("^[0-9a-f]+$")
    private const val WIRE_KEYS = "ed25519PubHex,issuedAt,mldsaPubHex,role,signature,subjectId,v"

    private fun fail(code: String): Nothing = throw PqTrustException(code)

    data class Statement(val role: String, val subjectId: String, val ed25519PubHex: String, val mldsaPubHex: String, val issuedAt: Long)

    data class Wire(val role: String, val subjectId: String, val ed25519PubHex: String, val mldsaPubHex: String, val issuedAt: Long, val signature: String) {
        val statement get() = Statement(role, subjectId, ed25519PubHex, mldsaPubHex, issuedAt)

        fun toJson(): JsonObject = buildJsonObject {
            put("v", 1)
            put("role", role)
            put("subjectId", subjectId)
            put("ed25519PubHex", ed25519PubHex)
            put("mldsaPubHex", mldsaPubHex)
            put("issuedAt", issuedAt)
            put("signature", signature)
        }
    }

    private fun checkStatement(s: Statement) {
        if (s.role !in ROLES) fail("binding-role")
        if (!SUBJECT.matches(s.subjectId)) fail("binding-subject")
        if (!HEX32.matches(s.ed25519PubHex)) fail("binding-malformed")
        if (s.mldsaPubHex.length != MLDSA65_PK_HEX_LEN || !HEX_MLDSA.matches(s.mldsaPubHex)) fail("binding-malformed")
        if (s.issuedAt !in 0..PqHybrid.MAX_SAFE_INTEGER) fail("binding-malformed")
    }

    /** The statement both keys sign. */
    fun canonicalPqKeyBinding(s: Statement): ByteArray {
        checkStatement(s)
        return listOf(TAG_PQ_KEY_BINDING, s.role, s.subjectId, s.ed25519PubHex, s.mldsaPubHex, s.issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun pqBindingPublicKey(ed25519PubHex: String, mldsaPubHex: String): ByteArray =
        PqHex.decode(ed25519PubHex + mldsaPubHex) ?: fail("binding-malformed")

    /** Signs [s] with a hybrid signer over the statement (purpose = the binding tag). */
    fun signPqKeyBinding(s: Statement, signer: (ByteArray) -> ByteArray): Wire {
        val sig = signer(canonicalPqKeyBinding(s))
        return Wire(s.role, s.subjectId, s.ed25519PubHex, s.mldsaPubHex, s.issuedAt, PqHex.encode(sig))
    }

    /**
     * A binding that verified. Its constructor is private: only [verifyPqKeyBinding] makes one,
     * and the gate refuses anything else (a module-private registry in TS, private fields in Rust).
     */
    class VerifiedBinding private constructor(
        val role: String,
        val subjectId: String,
        val ed25519PubHex: String,
        val mldsaPubHex: String,
        val issuedAt: Long,
        val hybridPublicKey: ByteArray,
        val keyIdHex: String,
        internal val token: Any,
    ) {
        internal companion object {
            val TOKEN = Any()
            fun mint(w: Wire, pk: ByteArray) = VerifiedBinding(
                w.role, w.subjectId, w.ed25519PubHex, w.mldsaPubHex, w.issuedAt, pk,
                PqHex.encode(PqHybrid.pqKeyId(PqHybrid.SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pk)), TOKEN,
            )
        }
    }

    data class Expectation(
        val role: String,
        val subjectId: String,
        /** The Ed25519 key the verifier already trusts (pinned, or registered). */
        val ed25519PubHex: String,
        /** The ML-DSA key already pinned for this identity, if any: a different one is refused. */
        val mldsaPubHex: String? = null,
        val now: Long,
        /** Refuse a binding dated before this. */
        val minIssuedAt: Long? = null,
    )

    private fun safeInt(e: JsonElement?): Long? {
        val p = e as? JsonPrimitive ?: return null
        if (p.isString) return null
        val d = p.content.toDoubleOrNull() ?: return null
        if (d.isNaN() || d.isInfinite() || d != Math.floor(d) || d < 0 || d > PqHybrid.MAX_SAFE_INTEGER) return null
        return d.toLong()
    }

    private fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** Parses the wire shape strictly; codes as [verifyPqKeyBinding]. */
    fun pqKeyBindingFromWire(w: JsonElement?): Wire {
        val o = w as? JsonObject ?: fail("binding-malformed")
        if (o.keys.sorted().joinToString(",") != WIRE_KEYS) fail("binding-malformed")
        val v = o["v"] as? JsonPrimitive
        if (v == null || v.isString || v.content.toDoubleOrNull() != 1.0) fail("binding-malformed")
        val sig = str(o["signature"])
        if (sig == null || sig.length > 2 * 65536 || !PqHex.isHex(sig)) fail("binding-malformed")
        val ed = str(o["ed25519PubHex"])
        if (ed == null || !HEX32.matches(ed)) fail("binding-malformed")
        val ml = str(o["mldsaPubHex"])
        if (ml == null || ml.length != MLDSA65_PK_HEX_LEN || !HEX_MLDSA.matches(ml)) fail("binding-malformed")
        val issuedAt = safeInt(o["issuedAt"]) ?: fail("binding-malformed")
        val role = str(o["role"])
        if (role == null || role !in ROLES) fail("binding-role")
        val subject = str(o["subjectId"])
        if (subject == null || !SUBJECT.matches(subject)) fail("binding-subject")
        return Wire(role, subject, ed, ml, issuedAt, sig)
    }

    /**
     * Verifies a binding. Order (every port): wire shape; role, subject and Ed25519 key against
     * what the verifier expects; a changed ML-DSA pin; dated in the future; older than allowed;
     * the hybrid public key; the hybrid signature over the statement.
     */
    fun verifyPqKeyBinding(wire: JsonElement?, expect: Expectation): VerifiedBinding =
        verifyParsed(pqKeyBindingFromWire(wire), expect)

    fun verifyPqKeyBinding(wire: Wire, expect: Expectation): VerifiedBinding =
        verifyPqKeyBinding(wire.toJson(), expect)

    private fun verifyParsed(w: Wire, expect: Expectation): VerifiedBinding {
        if (w.role != expect.role) fail("binding-role")
        if (w.subjectId != expect.subjectId) fail("binding-subject")
        if (w.ed25519PubHex != expect.ed25519PubHex.lowercase()) fail("binding-key-mismatch")
        if (!expect.mldsaPubHex.isNullOrEmpty() && w.mldsaPubHex != expect.mldsaPubHex.lowercase()) fail("binding-pq-key-changed")
        if (w.issuedAt > expect.now + MAX_SKEW_MS) fail("binding-future")
        if (expect.minIssuedAt != null && w.issuedAt < expect.minIssuedAt) fail("binding-stale")
        val pk = pqBindingPublicKey(w.ed25519PubHex, w.mldsaPubHex)
        val sig = PqHex.decode(w.signature) ?: fail("binding-malformed")
        try {
            PqHybrid.parseHybridSigPublicKey(pk)
        } catch (_: PqHybridException) {
            fail("bad-public-key")
        }
        try {
            PqHybrid.hybridVerify(pk, TAG_PQ_KEY_BINDING, canonicalPqKeyBinding(w.statement), sig)
        } catch (e: PqHybridException) {
            if (e.code == "bad-public-key") fail("bad-public-key")
            fail("bad-signature")
        }
        return VerifiedBinding.mint(w, pk)
    }

    // ── the gate ─────────────────────────────────────────────────────────

    data class SignatureEnvelope(val suite: String, val signature: String)

    data class Verdict(val suite: String, val strict: Boolean)

    /** Everything before the first `|`, or "" when there is none (or it is not strict UTF-8). */
    fun messagePurpose(msg: ByteArray): String {
        val bar = msg.indexOf(0x7c.toByte())
        if (bar <= 0) return ""
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(msg, 0, bar)).toString()
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * The one check for a critical signature. Order (every port): purpose grammar and match; the
     * envelope's suite and signature encoding; the binding is a verified one for this signer; the
     * scope's policy (strict needs the hybrid suite and a binding); the signature itself.
     */
    fun verifyCriticalSignature(
        message: ByteArray,
        expectedPurpose: String,
        envelope: SignatureEnvelope,
        signerEd25519PubHex: String,
        binding: VerifiedBinding?,
        policy: AssurancePolicy.PolicyState,
    ): Verdict {
        if (!PqHybrid.validatePurposeTag(expectedPurpose)) fail("bad-purpose")
        if (messagePurpose(message) != expectedPurpose) fail("purpose-mismatch")
        val suite = envelope.suite
        if (suite != SUITE_ED25519 && suite != SUITE_HYBRID) fail("unknown-suite")
        if (!PqHex.isHex(envelope.signature)) fail("bad-signature")
        val signer = signerEd25519PubHex.lowercase()
        if (!HEX32.matches(signer)) fail("bad-public-key")
        if (binding != null) {
            if (binding.token !== VerifiedBinding.TOKEN) fail("no-binding")
            if (binding.ed25519PubHex != signer) fail("binding-key-mismatch")
        }
        val strict = AssurancePolicy.strictInForce(policy)
        if (strict && suite != SUITE_HYBRID) fail("strict-requires-hybrid")
        if (strict && binding == null) fail("strict-requires-binding")
        val sig = PqHex.decode(envelope.signature) ?: fail("bad-signature")
        if (suite == SUITE_HYBRID) {
            if (binding == null) fail("no-binding")
            if (sig.size != PqHybrid.HYBRID_SIG_LEN) fail("bad-signature")
            try {
                PqHybrid.hybridVerify(binding.hybridPublicKey, expectedPurpose, message, sig)
            } catch (_: PqHybridException) {
                fail("bad-signature")
            }
        } else {
            if (sig.size != ED25519_SIG_LEN) fail("bad-signature")
            if (!PqHybrid.ed25519VerifyStrict(sig, message, PqHex.decode(signer)!!)) fail("bad-signature")
        }
        return Verdict(suite, strict)
    }
}
