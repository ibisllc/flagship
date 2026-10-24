package com.flagshipserver.app.core.pq

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

// A served chain replayed through the gate, as `.com`, the box and the phone do it.
class AssurancePolicyChainTest {
    private val edSeed = ByteArray(32) { 0x11 }
    private val mlSeed = ByteArray(32) { 0x22 }
    private val sk = edSeed + mlSeed
    private val edPub = PqHex.encode(PqHybrid.ed25519PublicKey(edSeed))
    private val now = 1_793_000_000_000L
    private val scope = AssurancePolicy.Scope("installation", "home.alice.flagship.services")

    private val binding = PqTrust.verifyPqKeyBinding(
        PqTrust.signPqKeyBinding(PqTrust.Statement("device", "0".repeat(32), edPub, PqHex.encode(PqHybrid.mldsa65PublicKey(mlSeed)), now)) { m ->
            PqHybrid.hybridSign(sk, PqTrust.TAG_PQ_KEY_BINDING, m)
        },
        PqTrust.Expectation("device", "0".repeat(32), edPub, now = now),
    )

    private fun change(gen: Long, prior: String, next: String, prev: String, suite: String = PqTrust.SUITE_HYBRID) = AssurancePolicy.Change(
        account = "alice", scope = scope, prior = prior, next = next, generation = gen, prevDigest = prev,
        affectedPeersDigest = "a".repeat(64),
        acknowledgedLoss = if (next == "compatibility") listOf("classical-signatures-accepted") else emptyList(),
        signerKind = "admin-device", signerKeyId = edPub, suite = suite, issuedAt = now + gen,
    )

    private fun signed(c: AssurancePolicy.Change): AssurancePolicy.SignedChange {
        val msg = AssurancePolicy.canonical(c)
        val sig = if (c.suite == PqTrust.SUITE_HYBRID) PqHybrid.hybridSign(sk, AssurancePolicy.TAG_ASSURANCE_POLICY, msg) else PqHybrid.ed25519Sign(edSeed, msg)
        return AssurancePolicy.SignedChange(c, PqTrust.SignatureEnvelope(c.suite, PqHex.encode(sig)))
    }

    private val prepared = AssurancePolicy.legacyState(scope)
        .let { AssurancePolicy.advanceRollout(it, "capable", AssurancePolicy.RolloutEvidence(capabilityAdvertised = true)) }
        .let { AssurancePolicy.advanceRollout(it, "prepared", AssurancePolicy.RolloutEvidence(boundPublicKeys = true, recipientsVerified = true, recoveryChecked = true)) }

    private fun replay(chain: List<AssurancePolicy.SignedChange>) =
        AssurancePolicy.replay(prepared, chain) { e, before -> AssurancePolicy.gateCheck(e, before) { edPub to binding } }

    @Test
    fun strictThenOptOutReplays() {
        val c1 = change(1, "compatibility", "strict", AssurancePolicy.GENESIS_DIGEST)
        val s1 = replay(listOf(signed(c1)))
        assertTrue(AssurancePolicy.strictInForce(s1))
        val c2 = change(2, "strict", "compatibility", AssurancePolicy.digest(c1))
        val s2 = replay(listOf(signed(c1), signed(c2)))
        assertFalse(AssurancePolicy.strictInForce(s2))
        assertTrue(s2.enforcedEver)
        assertEquals(AssurancePolicy.digest(c2), s2.headDigest)
    }

    @Test
    fun aClassicalSignerCannotTurnStrictOnOrOff() {
        val c1 = change(1, "compatibility", "strict", AssurancePolicy.GENESIS_DIGEST, suite = PqTrust.SUITE_ED25519)
        expect("classical-signer-refused") { replay(listOf(signed(c1))) }
        val h1 = change(1, "compatibility", "strict", AssurancePolicy.GENESIS_DIGEST)
        val off = change(2, "strict", "compatibility", AssurancePolicy.digest(h1), suite = PqTrust.SUITE_ED25519)
        // Under strict the gate itself refuses the classical envelope.
        expect("bad-signature") { replay(listOf(signed(h1), signed(off))) }
    }

    @Test
    fun forksGapsAndStrippedSignaturesAreRefused() {
        val c1 = change(1, "compatibility", "strict", AssurancePolicy.GENESIS_DIGEST)
        expect("broken-chain") { replay(listOf(signed(c1), signed(change(2, "strict", "compatibility", "b".repeat(64))))) }
        expect("stale-generation") { replay(listOf(signed(c1), signed(change(3, "strict", "compatibility", AssurancePolicy.digest(c1))))) }
        val stripped = signed(c1).let { it.copy(signature = PqTrust.SignatureEnvelope(PqTrust.SUITE_ED25519, it.signature.signature.substring(0, 128))) }
        expect("bad-signature") { replay(listOf(stripped)) }
    }

    @Test
    fun aStoredStateNeverMovesBack() {
        val c1 = change(1, "compatibility", "strict", AssurancePolicy.GENESIS_DIGEST)
        val s1 = replay(listOf(signed(c1)))
        try {
            AssurancePolicy.adoptStoredState(s1, prepared)
            fail("rollback accepted")
        } catch (e: PolicyException) {
            assertEquals("rollback-refused", e.code)
        }
        assertEquals(s1, AssurancePolicyWire.chainFromJson(kotlinx.serialization.json.buildJsonObject {
            put("chain", kotlinx.serialization.json.JsonArray(listOf(kotlinx.serialization.json.buildJsonObject {
                put("change", AssurancePolicyWire.changeToJson(c1))
                put("signature", kotlinx.serialization.json.buildJsonObject {
                    put("suite", kotlinx.serialization.json.JsonPrimitive(signed(c1).signature.suite))
                    put("signature", kotlinx.serialization.json.JsonPrimitive(signed(c1).signature.signature))
                })
            })))
        }).let { replay(it) })
    }

    private fun expect(code: String, f: () -> Unit) {
        try {
            f(); fail("expected $code")
        } catch (e: PolicyException) {
            assertEquals(code, e.code)
        }
    }
}
