// SEC-LOCK-001 on Android: the canonical bytes are the shared vectors', and
// lock / resume behave against a worker that follows the same rules.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.BootSuspensionOrderWire
import com.flagshipserver.app.api.BootSuspensionPutResult
import com.flagshipserver.app.api.BootSuspensionStateWire
import com.flagshipserver.app.api.SecretMailboxClient
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.lang.reflect.Proxy

class BootSuspensionTest {
    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/boot-suspension/vectors.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        runCatching { javaClass.protectionDomain?.codeSource?.location?.toURI()?.let { candidates.add(File(it)) } }
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 14) {
                val f = File(dir, rel)
                if (f.isFile) return f
                dir = dir.parentFile
                hops += 1
            }
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private val root: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String): Long = this[k]!!.jsonPrimitive.long

    private fun order(o: JsonObject) = BootSuspensionOrder(
        serverDomain = o.s("serverDomain"),
        epoch = o.l("epoch"),
        seq = o.l("seq"),
        action = if (o.s("action") == "suspend") BootSuspensionOrder.Action.SUSPEND else BootSuspensionOrder.Action.RESUME,
        reason = o.s("reason"),
        signer = o.s("signer"),
        issuedAt = o.l("issuedAt"),
    )

    @Test
    fun everyStepHasTheSharedCanonicalBytesAndItsSignatureVerifies() {
        val steps = root["steps"]!!.jsonArray
        assertTrue(steps.isNotEmpty())
        val ownerPub = HexUtil.decode(root.s("ownerPubHex"))!!
        val boxPub = HexUtil.decode(root.s("boxPubHex"))!!
        for (st in steps) {
            val s = st.jsonObject
            val o = order(s["order"]!!.jsonObject)
            val canonical = o.canonicalBytes()
            assertEquals(s.s("name"), s.s("canonical"), String(canonical, Charsets.UTF_8))
            val sig = HexUtil.decode(s.s("signatureHex"))!!
            val (right, wrong) = if (o.signer == "owner") ownerPub to boxPub else boxPub to ownerPub
            Ed25519Verify(right).verify(sig, canonical)
            assertThrows(java.security.GeneralSecurityException::class.java) { Ed25519Verify(wrong).verify(sig, canonical) }
        }
    }

    @Test
    fun fieldsThatWouldBreakTheFormAreRefused() {
        val ok = BootSuspensionOrder("a.b", 1, 0, BootSuspensionOrder.Action.SUSPEND, "manual-lock", "owner", 1)
        ok.canonicalBytes()
        for (bad in listOf(
            ok.copy(serverDomain = "a|b"), ok.copy(epoch = -1), ok.copy(reason = "x\ny"), ok.copy(signer = "root"),
            ok.copy(serverDomain = ""),
        )) {
            assertThrows(IllegalArgumentException::class.java) { bad.canonicalBytes() }
        }
    }

    // ---- against a worker that follows the rules ----

    private class Worker {
        var state = BootSuspensionStateWire("home.alice.flagship.services", false, 0, 0)
        var leases = 2
        var down = false
        var failWrites = false
        val puts = mutableListOf<BootSuspensionOrderWire>()
        var beforeFirstPut: (() -> Unit)? = null

        fun read(): BootSuspensionStateWire {
            if (down) throw java.io.IOException("offline")
            return state
        }

        fun put(order: BootSuspensionOrderWire): BootSuspensionPutResult {
            if (down) throw java.io.IOException("offline")
            puts += order
            beforeFirstPut?.let { beforeFirstPut = null; it() }
            if (failWrites) return BootSuspensionPutResult(false, refusal = "not-durable", status = 503)
            if (order.epoch != state.epoch + 1) return BootSuspensionPutResult(false, state = state, refusal = "stale-epoch", status = 409)
            val revoked = if (order.action == "suspend") leases else 0
            if (order.action == "suspend") leases = 0
            state = BootSuspensionStateWire(order.serverDomain, order.action == "suspend", order.epoch, 0, order.reason, "owner")
            return BootSuspensionPutResult(true, leasesRevoked = revoked, state = state)
        }

        fun client(): SecretMailboxClient = Proxy.newProxyInstance(
            SecretMailboxClient::class.java.classLoader,
            arrayOf(SecretMailboxClient::class.java),
        ) { _, method, args ->
            when (method.name) {
                "readBootSuspension" -> read()
                "putBootSuspension" -> put(args[0] as BootSuspensionOrderWire)
                else -> throw UnsupportedOperationException(method.name)
            }
        } as SecretMailboxClient
    }

    private val S = "home.alice.flagship.services"
    private fun key(): Pair<Ed25519Sign, String> {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        return Ed25519Sign(kp.privateKey) to HexUtil.encode(kp.publicKey)
    }
    private fun lock(w: Worker) = BootLock(w.client(), now = { 1_800_000_000_000 }, nonce = { ByteArray(32) { 1 } })

    @Test
    fun lockIsDurableRevokesLeasesAndSignsTheNextEpoch() = runBlocking {
        val w = Worker()
        val (k, pub) = key()
        val b = lock(w)
        assertEquals(BootLockOutcome.Confirmed(2, false), b.setOwner(S, BootSuspensionOrder.Action.SUSPEND, k, pub))
        assertEquals(listOf(1L), w.puts.map { it.epoch })
        assertTrue(w.state.suspended)
        // locking a locked server is a no-op, not a second epoch
        assertEquals(BootLockOutcome.Confirmed(0, true), b.setOwner(S, BootSuspensionOrder.Action.SUSPEND, k, pub))
        assertEquals(1, w.puts.size)
        // resume starts epoch 2 and leaves no lease behind
        assertEquals(BootLockOutcome.Confirmed(0, false), b.setOwner(S, BootSuspensionOrder.Action.RESUME, k, pub))
        assertEquals(listOf(1L, 2L), w.puts.map { it.epoch })
        assertEquals(0, w.leases)
    }

    @Test
    fun anUnreachableOrNonDurableWorkerIsNeverReportedAsLocked() = runBlocking {
        val (k, pub) = key()
        val down = Worker().apply { this.down = true }
        assertEquals(BootLockOutcome.Pending("unreachable"), lock(down).setOwner(S, BootSuspensionOrder.Action.SUSPEND, k, pub))
        val broken = Worker().apply { failWrites = true }
        assertEquals(BootLockOutcome.Pending("not-durable"), lock(broken).setOwner(S, BootSuspensionOrder.Action.SUSPEND, k, pub))
        assertFalse(broken.state.suspended)
    }

    @Test
    fun retriesOnAMovedEpoch() = runBlocking {
        val (k, pub) = key()
        val w = Worker()
        // The record moves on after the phone read it (epoch 0) and before its write (epoch 1).
        w.beforeFirstPut = { w.state = BootSuspensionStateWire(S, false, 1, 0) }
        assertEquals(BootLockOutcome.Confirmed(2, false), lock(w).setOwner(S, BootSuspensionOrder.Action.SUSPEND, k, pub))
        assertEquals(listOf(1L, 2L), w.puts.map { it.epoch })
        assertEquals(2L, w.state.epoch)
    }

    @Test
    fun deadManBoundsALease() {
        assertEquals(1_000L, DeadManLeaseBound.expiry(1_000, false, null, 10))
        assertEquals(500L, DeadManLeaseBound.expiry(1_000, true, 500, 10))
        assertEquals(300L, DeadManLeaseBound.expiry(300, true, 500, 10))
        assertNull(DeadManLeaseBound.expiry(1_000, true, 5, 10))
        assertNull(DeadManLeaseBound.expiry(1_000, true, null, 10))
    }

    @Test
    fun theWordsNeverOverclaim() {
        assertTrue(LockWords.describe(BootLockOutcome.Pending("x"), true, PowerMode.OFF).contains("remote lock pending"))
        assertFalse(LockWords.describe(BootLockOutcome.Pending("x"), true, PowerMode.OFF).contains("can't unlock itself"))
        assertTrue(LockWords.describe(BootLockOutcome.Confirmed(1, false), false, PowerMode.OFF).contains("didn't reach"))
        assertTrue(LockWords.describe(BootLockOutcome.Confirmed(0, false), true, PowerMode.RESTART, PowerMode.OFF).contains("shut down instead"))
    }
}
