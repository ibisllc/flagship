package com.flagshipserver.app.core.pq

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class QuantumSafetyTest {
    private val account = "alice"
    private val server = "home.alice.flagship.services"
    private val edSeed = ByteArray(32) { 0x31 }
    private val mlSeed = ByteArray(32) { 0x32 }
    private val sk = edSeed + mlSeed
    private val edPub = PqHybrid.ed25519PublicKey(edSeed)
    private val root = PqHex.encode(edPub)

    private fun binding(): PqTrust.VerifiedBinding {
        val st = PqTrust.Statement("admin-root", account, root, PqHex.encode(PqHybrid.mldsa65PublicKey(mlSeed)), 1)
        val w = PqTrust.signPqKeyBinding(st) { m -> PqHybrid.hybridSign(sk, PqTrust.TAG_PQ_KEY_BINDING, m) }
        return PqTrust.verifyPqKeyBinding(w, PqTrust.Expectation("admin-root", account, root, now = 10))
    }

    private fun signed(c: AssurancePolicy.Change): AssurancePolicy.SignedChange {
        val m = AssurancePolicy.canonical(c)
        return AssurancePolicy.SignedChange(c, PqTrust.SignatureEnvelope(PqTrust.SUITE_HYBRID, PqHex.encode(PqHybrid.hybridSign(sk, AssurancePolicy.TAG_ASSURANCE_POLICY, m))))
    }

    private class Mem : QuantumSafety.Persistence {
        val m = HashMap<String, String>()
        override fun load(key: String) = m[key]
        override fun save(key: String, value: String) { m[key] = value }
        override fun keys() = m.keys.toSet()
        override fun remove(key: String) { m.remove(key) }
    }

    @Test
    fun strictWithTheBrowserAnswerLeavingItAndAntiRollback() {
        val b = binding()
        val scope = AssurancePolicy.Scope("installation", server)
        val trust: (AssurancePolicy.Change) -> Pair<String, PqTrust.VerifiedBinding?>? = { c -> if (c.signerKeyId == root) root to b else null }
        val on = signed(QuantumSafety.strictChange(account, scope, AssurancePolicy.legacyState(scope), true, listOf(server), "admin-root", root, 100))
        val r1 = QuantumSafety.replay(scope, account, listOf(on), null, trust)
        assertTrue(r1.strict)
        assertTrue(r1.browsersAllowed)
        val off = signed(QuantumSafety.compatibilityChange(account, scope, r1.state, QuantumSafety.LEAVING_STRICT_LOSS, listOf(server), "admin-root", root, 200))
        val r2 = QuantumSafety.replay(scope, account, listOf(on, off), r1.state, trust)
        assertFalse(r2.strict)
        val store = QuantumSafety.Store(Mem())
        store.adopt(account, r2)
        assertThrows(PolicyException::class.java) { store.adopt(account, r1) }
        assertEquals(r2.state, store.replayed(account, scope)?.state)
        assertFalse(store.anyStrict(account))
        store.forget(account)
        assertNull(store.replayed(account, scope))
        // Without the trusted binding the change does not verify: no strict state from a forged chain.
        assertThrows(PolicyException::class.java) { QuantumSafety.replay(scope, account, listOf(on), null) { null } }
    }

    @Test
    fun readinessAndConnectors() {
        val r = QuantumSafety.Readiness(1, 2, true, true, false, true)
        assertFalse(r.ready)
        assertEquals(2, r.missing.size)
        assertEquals(listOf("ai-flagship-inference", "ai-openai"), QuantumSafety.connectors(listOf("openai")).filter { it.needsChoice }.map { it.id })
        assertEquals(QuantumSafety.affectedPeersDigest(listOf("B", "a")), QuantumSafety.affectedPeersDigest(listOf("a", "b", "b")))
    }
}
