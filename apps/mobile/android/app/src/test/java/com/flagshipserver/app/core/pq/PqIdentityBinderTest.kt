package com.flagshipserver.app.core.pq

import com.flagshipserver.app.core.BoxKeyChangedException
import com.flagshipserver.app.core.BoxKeyPins
import com.flagshipserver.app.keystore.PqCustodyLabel
import com.flagshipserver.app.keystore.PqKeyStore
import com.flagshipserver.app.keystore.PqSeedWrapper
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PqIdentityBinderTest {
    private class MemPersistence : PqKeyStore.Persistence {
        val map = HashMap<String, String>()
        override fun load(key: String) = map[key]
        override fun save(key: String, value: String) { map[key] = value }
        override fun remove(key: String) { map.remove(key) }
    }

    /** Stands in for the Keystore key: XOR with a fixed pad, and a switch for "needs auth". */
    private class FakeWrapper : PqSeedWrapper {
        var locked = false
        override val label = PqCustodyLabel.HARDWARE_WRAPPED
        override fun wrap(seed: ByteArray) = ByteArray(seed.size) { (seed[it].toInt() xor 0x5a).toByte() }
        override fun unwrap(blob: ByteArray): ByteArray {
            if (locked) throw IllegalStateException("UserNotAuthenticated")
            return ByteArray(blob.size) { (blob[it].toInt() xor 0x5a).toByte() }
        }
    }

    private class FakeClient : PqKeyBindingClient {
        val stored = HashMap<String, PqTrust.Wire>()
        var offline = false
        var puts = 0
        override suspend fun put(username: String, wire: PqTrust.Wire): PqKeyBindingClient.PutResult {
            puts++
            if (offline) return PqKeyBindingClient.PutResult.Deferred("network")
            // `.com`'s rule: verify, then keep the first ML-DSA key per Ed25519 key.
            runCatching { PqTrust.verifyPqKeyBinding(wire, PqTrust.Expectation(wire.role, wire.subjectId, wire.ed25519PubHex, now = wire.issuedAt)) }
                .onFailure { return PqKeyBindingClient.PutResult.Deferred("403") }
            val k = "${wire.role}|${wire.subjectId}"
            val cur = stored[k]
            if (cur != null && cur.ed25519PubHex == wire.ed25519PubHex) {
                if (cur.mldsaPubHex != wire.mldsaPubHex) return PqKeyBindingClient.PutResult.KeyChanged
                if (wire.issuedAt <= cur.issuedAt) return PqKeyBindingClient.PutResult.Stale
            }
            stored[k] = wire
            return PqKeyBindingClient.PutResult.Stored
        }
        override suspend fun get(username: String) = if (offline) null else PqKeyBindingClient.Bindings(
            stored.values.firstOrNull { it.role == "account-irk" },
            stored.values.firstOrNull { it.role == "admin-root" },
            stored.values.filter { it.role == "device" },
        )
    }

    private val edSeed = ByteArray(32) { 7 }
    private val edPub = PqHex.encode(PqHybrid.ed25519PublicKey(edSeed))
    private fun irk() = PqIdentityBinder.Identity("account-irk", "alice", edPub) { m -> PqHybrid.ed25519Sign(edSeed, m) }
    private var clock = 1_790_000_000_000L

    @Test
    fun bindsOnceThenSkips() = runBlocking {
        val store = PqKeyStore(MemPersistence(), FakeWrapper(), profile = { "alice" })
        val client = FakeClient()
        val binder = PqIdentityBinder(store, client) { clock }
        assertEquals(PqIdentityBinder.Outcome.BOUND, binder.bindAll("alice", listOf(irk()))["account-irk"])
        val e = store.entry("account-irk", "alice")!!
        assertEquals(PqKeyStore.BindingState.BOUND, e.bindingState)
        assertEquals("PQ, hardware-wrapped", e.label.text)
        assertEquals(e.mldsaPubHex, client.stored["account-irk|alice"]!!.mldsaPubHex)
        // The seed is stored wrapped, never as the key it derives.
        assertNotEquals(e.wrappedSeedHex, e.mldsaPubHex)
        assertEquals(PqIdentityBinder.Outcome.SKIPPED, binder.bindAll("alice", listOf(irk()))["account-irk"])
        assertEquals(1, client.puts)
    }

    @Test
    fun aSecondDeviceNeverCompetesForTheSameRoot() = runBlocking {
        val client = FakeClient()
        clock++
        PqIdentityBinder(PqKeyStore(MemPersistence(), FakeWrapper(), profile = { "a" }), client) { clock }.bindAll("alice", listOf(irk()))
        val other = PqKeyStore(MemPersistence(), FakeWrapper(), profile = { "a" })
        val out = PqIdentityBinder(other, client) { clock + 1 }.bindAll("alice", listOf(irk()))
        assertEquals(PqIdentityBinder.Outcome.BOUND_ELSEWHERE, out["account-irk"])
        assertEquals(1, client.puts)
        assertEquals(PqKeyStore.BindingState.BOUND_ELSEWHERE, other.entry("account-irk", "alice")!!.bindingState)
    }

    @Test
    fun aLostRaceIsRecordedNotRetried() = runBlocking {
        val client = FakeClient()
        val first = PqKeyStore(MemPersistence(), FakeWrapper(), profile = { "a" })
        PqIdentityBinder(first, client) { clock }.bindAll("alice", listOf(irk()))
        // A device that read `.com` before the other one won: its PUT gets pq-key-changed.
        val late = PqKeyStore(MemPersistence(), FakeWrapper(), profile = { "a" })
        val blind = object : PqKeyBindingClient by client {
            override suspend fun get(username: String): PqKeyBindingClient.Bindings? = null
        }
        val out = PqIdentityBinder(late, blind) { clock + 5 }.bindAll("alice", listOf(irk()))
        assertEquals(PqIdentityBinder.Outcome.BOUND_ELSEWHERE, out["account-irk"])
        assertEquals(PqKeyStore.BindingState.BOUND_ELSEWHERE, late.entry("account-irk", "alice")!!.bindingState)
    }

    @Test
    fun defersWhenOfflineOrLockedAndKeepsTheSameKey() = runBlocking {
        val wrapper = FakeWrapper()
        val store = PqKeyStore(MemPersistence(), wrapper, profile = { "a" })
        val client = FakeClient()
        val binder = PqIdentityBinder(store, client) { clock }
        wrapper.locked = true
        assertEquals(PqIdentityBinder.Outcome.DEFERRED, binder.bindAll("alice", listOf(irk()))["account-irk"])
        val key = store.entry("account-irk", "alice")!!.mldsaPubHex
        wrapper.locked = false
        client.offline = true
        assertEquals(PqIdentityBinder.Outcome.DEFERRED, binder.bindAll("alice", listOf(irk()))["account-irk"])
        client.offline = false
        assertEquals(PqIdentityBinder.Outcome.BOUND, binder.bindAll("alice", listOf(irk()))["account-irk"])
        assertEquals(key, client.stored["account-irk|alice"]!!.mldsaPubHex)
    }

    @Test
    fun aRotatedIdentityGetsAFreshKey() = runBlocking {
        val store = PqKeyStore(MemPersistence(), FakeWrapper(), profile = { "a" })
        val first = store.getOrCreate("account-irk", "alice", edPub, clock)
        val rotated = PqHex.encode(PqHybrid.ed25519PublicKey(ByteArray(32) { 9 }))
        val second = store.getOrCreate("account-irk", "alice", rotated, clock)
        assertNotEquals(first.mldsaPubHex, second.mldsaPubHex)
        assertEquals(second, store.getOrCreate("account-irk", "alice", rotated, clock))
    }

    @Test
    fun answersMatchTheServerContract() {
        assertEquals(PqKeyBindingClient.PutResult.Stored, PqBindingAnswers.put(200, """{"ok":true}"""))
        assertEquals(PqKeyBindingClient.PutResult.Stale, PqBindingAnswers.put(409, """{"error":"stale"}"""))
        assertEquals(PqKeyBindingClient.PutResult.KeyChanged, PqBindingAnswers.put(409, """{"error":"pq-key-changed"}"""))
        assertTrue(PqBindingAnswers.put(403, """{"error":"binding-key-mismatch"}""") is PqKeyBindingClient.PutResult.Deferred)
        assertTrue(PqBindingAnswers.put(404, "") is PqKeyBindingClient.PutResult.Deferred)
        val v = PqVectors.load("packages/protocol/test-vectors/pq-binding/vectors.json")
        val valid = v["bindings"]!!.jsonObject["valid"]!!.jsonArray.map { it.jsonObject }
        val irk = valid.first { it["name"]!!.jsonPrimitive.content == "account-irk" }["wire"]!!
        val dev = valid.first { it["name"]!!.jsonPrimitive.content == "device" }["wire"]!!
        val b = PqBindingAnswers.bindings("""{"username":"alice","accountIrk":$irk,"adminRoot":null,"devices":[$dev]}""")!!
        assertEquals("account-irk", b.accountIrk!!.role)
        assertNull(b.adminRoot)
        assertEquals(1, b.devices.size)
    }

    @Test
    fun boxPinsTheStkBindingAndRequiresTheHybridBootBinding() {
        val v = PqVectors.load("packages/protocol/test-vectors/pq-binding/vectors.json")
        val signer = v["signers"]!!.jsonArray[0].jsonObject
        val sk = PqHex.decode(signer["edSeedHex"]!!.jsonPrimitive.content + signer["mldsaSeedHex"]!!.jsonPrimitive.content)!!
        val wire = v["bindings"]!!.jsonObject["valid"]!!.jsonArray.map { it.jsonObject }
            .first { it["name"]!!.jsonPrimitive.content == "box-stk" }["wire"]!!
        val w = PqTrust.pqKeyBindingFromWire(wire)
        val pins = BoxKeyPins(now = { w.issuedAt })
        assertNull(pins.acceptStkPqBinding("alice", w.subjectId, wire))
        pins.require("alice", w.subjectId, w.ed25519PubHex)
        assertEquals(w.mldsaPubHex, pins.acceptStkPqBinding("alice", w.subjectId, wire))
        assertEquals(w.mldsaPubHex, pins.pinnedBoxPqKey("alice", w.subjectId))

        val bootSeed = ByteArray(32) { 3 }
        val boot = PqHex.encode(PqHybrid.ed25519PublicKey(bootSeed))
        val v1 = PqHex.encode(PqHybrid.ed25519Sign(sk.copyOfRange(0, 32), BoxKeyPins.canonicalBootKeyBinding(w.subjectId, boot, 10)!!))
        // Stripped of its hybrid signature: refused once the ML-DSA key is pinned.
        assertNull(pins.acceptBootKeyBinding("alice", w.subjectId, boot, 10, v1))
        val v2 = PqHex.encode(PqHybrid.hybridSign(sk, BoxPqKeyPin.TAG_BOOT_KEY_BINDING_V2, BoxPqKeyPin.canonicalBootKeyBindingV2(w.subjectId, boot, 10)))
        assertEquals(boot, pins.acceptBootKeyBinding("alice", w.subjectId, boot, 10, v1, v2))

        // A binding naming another ML-DSA key is a key change.
        val other = PqTrust.signPqKeyBinding(w.statement.copy(mldsaPubHex = PqHex.encode(PqHybrid.mldsa65PublicKey(ByteArray(32) { 1 })), issuedAt = w.issuedAt + 1)) { m ->
            PqHybrid.hybridSign(sk.copyOfRange(0, 32) + ByteArray(32) { 1 }, PqTrust.TAG_PQ_KEY_BINDING, m)
        }
        try {
            pins.acceptStkPqBinding("alice", w.subjectId, other.toJson())
            fail("expected a key change")
        } catch (e: BoxKeyChangedException) {
            assertEquals(w.mldsaPubHex, e.pinnedHex)
        }
    }
}
