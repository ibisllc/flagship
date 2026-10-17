// "Update this server" VM logic (Android). Drives the VM against
// MockSecretMailboxClient, asserting the box-reported-commit gate, the target
// validation, the signed update wire body the `.com` lane accepts, and the
// admin-root-vs-IRK order signing. JVM-testable (injected signer/pub — no
// Android keystore).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.LastUpdate
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.core.InMemoryPendingUpdateStore
import com.flagshipserver.app.core.PendingUpdate
import com.flagshipserver.app.core.PendingUpdateStore
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.ServerUpdateOrder
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateServerViewModelTest {
    private val server = "home.alice.flagship.services"
    private val username = "alice"
    private val current = "1234567890abcdef1234567890abcdef12345678"
    private val target = "9f2c1ab3de4567890abcdef1234567890abcdef1"

    private val irkKp = Ed25519Sign.KeyPair.newKeyPair()
    private val adminKp = Ed25519Sign.KeyPair.newKeyPair()

    private fun vm(
        mailbox: MockSecretMailboxClient,
        currentCommit: String?,
        adminRoot: Boolean = false,
        onSign: () -> Unit = {},
        store: PendingUpdateStore = InMemoryPendingUpdateStore(),
        clock: () -> Long = { 1700L },
        serverFqdn: String = server,
    ) = UpdateServerViewModel(
        username = username,
        serverFqdn = serverFqdn,
        currentCommit = currentCommit,
        mailbox = mailbox,
        signer = { onSign(); Ed25519Sign(irkKp.privateKey) },
        irkPubHex = { HexUtil.encode(irkKp.publicKey) },
        orderSigner = { if (adminRoot) Ed25519Sign(adminKp.privateKey) else null },
        now = clock,
        pendingStore = store,
    )

    // ── Gating ────────────────────────────────────────────────────────────────

    @Test
    fun cannotUpdateWithoutBoxReportedCommit() = runTest {
        val mb = MockSecretMailboxClient()
        val m = vm(mb, currentCommit = null)
        assertFalse(m.canUpdate)
        assertNull(m.runningShort)
        assertFalse(m.update(target))
        assertTrue(m.phase.value is UpdateServerViewModel.Phase.Failed)
        assertTrue("must never mint without a box-reported fromCommit", mb.updateDeposits.isEmpty())
    }

    @Test
    fun rejectsMalformedTargetWithoutSigning() = runTest {
        val mb = MockSecretMailboxClient()
        var signed = false
        val m = vm(mb, currentCommit = current, onSign = { signed = true })
        assertFalse(m.update("deadbeef"))
        assertTrue(m.phase.value is UpdateServerViewModel.Phase.Failed)
        assertFalse("must validate before prompting the biometric", signed)
        assertTrue(mb.updateDeposits.isEmpty())
    }

    @Test
    fun rejectsTargetEqualToCurrent() = runTest {
        val mb = MockSecretMailboxClient()
        val m = vm(mb, currentCommit = current)
        assertFalse(m.canOrder(current))
        assertFalse(m.update(current))
        assertTrue(mb.updateDeposits.isEmpty())
    }

    // ── Mint → sign → deposit ────────────────────────────────────────────────

    @Test
    fun updateMintsSignsAndDepositsVerifiableOrder_adminRoot() = runTest {
        val mb = MockSecretMailboxClient()
        val m = vm(mb, currentCommit = current, adminRoot = true)
        assertTrue(m.update(target.uppercase())) // input normalizes
        assertEquals(UpdateServerViewModel.Phase.Done, m.phase.value)
        assertEquals(1, mb.updateDeposits.size)
        val (domain, body) = mb.updateDeposits[0]
        assertEquals(server, domain)
        assertEquals(server, body.order.serverDomain)
        assertEquals(target, body.order.targetCommit)
        assertEquals("fromCommit is the BOX-reported truth", current, body.order.fromCommit)
        assertEquals(1700L, body.order.issuedAt)

        // The order signature verifies under the ADMIN ROOT (Slice D), not the IRK.
        val canonical = ServerUpdateOrder.canonicalBytes(
            body.order.serverDomain, body.order.targetCommit,
            body.order.fromCommit, body.order.nonce, body.order.issuedAt,
        )
        val sig = HexUtil.decode(body.signature)!!
        Ed25519Verify(adminKp.publicKey).verify(sig, canonical) // throws on mismatch
        assertThrows(Throwable::class.java) {
            Ed25519Verify(irkKp.publicKey).verify(sig, canonical)
        }
        // The mailbox auth stays IRK-bound.
        assertEquals(HexUtil.encode(irkKp.publicKey), body.auth.phoneIrkPub)
    }

    @Test
    fun updateSignsWithIrkWhenNoAdminRoot() = runTest {
        val mb = MockSecretMailboxClient()
        val m = vm(mb, currentCommit = current, adminRoot = false)
        assertTrue(m.update(target))
        val body = mb.updateDeposits[0].second
        val canonical = ServerUpdateOrder.canonicalBytes(
            body.order.serverDomain, body.order.targetCommit,
            body.order.fromCommit, body.order.nonce, body.order.issuedAt,
        )
        Ed25519Verify(irkKp.publicKey).verify(HexUtil.decode(body.signature)!!, canonical)
    }

    @Test
    fun depositFailureSurfaces() = runTest {
        val mb = MockSecretMailboxClient()
        mb.nextUpdateError = HttpException(403, "no")
        val m = vm(mb, currentCommit = current)
        assertFalse(m.update(target))
        assertTrue(m.phase.value is UpdateServerViewModel.Phase.Failed)
        assertTrue(mb.updateDeposits.isEmpty())
    }

    // ── Display helpers ──────────────────────────────────────────────────────

    @Test
    fun runningShortAndTargetProblemCopy() {
        val m = vm(MockSecretMailboxClient(), currentCommit = current)
        assertEquals("12345678", m.runningShort)
        assertNull(m.targetProblem(""))
        assertTrue(m.targetProblem("nothex") != null)
        assertTrue(m.targetProblem(current) != null)
        assertNull(m.targetProblem(target))
        assertTrue(m.canOrder(" $target "))
    }

    // ── Pending order (remembered until the box reports) ─────────────────────

    private val minute = 60_000L
    private val t0 = 1_760_000_000_000L

    @Test
    fun successStoresPendingWithTagAndFromCommit() = runTest {
        val store = InMemoryPendingUpdateStore()
        val m = vm(MockSecretMailboxClient(), currentCommit = current, store = store, clock = { t0 })
        assertNull(m.pending.value)
        assertTrue(m.update(target, "v1.2.0"))
        val p = store.get(server)!!
        assertEquals(PendingUpdate(target, "v1.2.0", current, t0), p)
        assertEquals(p, m.pending.value)
        assertEquals("v1.2.0", p.label)
        // A fresh VM (sheet closed, page reopened) still knows.
        assertEquals(p, vm(MockSecretMailboxClient(), currentCommit = current, store = store).pending.value)
    }

    @Test
    fun failureStoresNothing() = runTest {
        val store = InMemoryPendingUpdateStore()
        val mb = MockSecretMailboxClient().apply { nextUpdateError = HttpException(500, "down") }
        val m = vm(mb, currentCommit = current, store = store)
        assertFalse(m.update(target))
        assertNull(store.get(server))
        assertNull(m.pending.value)
        assertFalse(vm(mb, currentCommit = current, store = store).update(current))
        assertNull(store.get(server))
    }

    @Test
    fun labelFallsBackToShortCommit() {
        assertEquals("9f2c1ab3", PendingUpdate(target, null, current, t0).label)
        assertEquals("9f2c1ab3", PendingUpdate(target, " ", current, t0).label)
    }

    @Test
    fun clearedWhenBoxRunsTheTarget() = runTest {
        val store = InMemoryPendingUpdateStore()
        vm(MockSecretMailboxClient(), currentCommit = current, store = store, clock = { t0 }).update(target)
        val stillOld = vm(MockSecretMailboxClient(), currentCommit = current, store = store)
        assertFalse(stillOld.reconcile(current, null))
        assertTrue(stillOld.pending.value != null)
        val moved = vm(MockSecretMailboxClient(), currentCommit = target, store = store)
        assertTrue(moved.reconcile(target.uppercase(), null))
        assertNull(moved.pending.value)
        assertNull(store.get(server))
    }

    @Test
    fun clearedByEachMatchingNewerOutcome() = runTest {
        for (outcome in listOf("applied", "rolled-back", "refused")) {
            val store = InMemoryPendingUpdateStore()
            val m = vm(MockSecretMailboxClient(), currentCommit = current, store = store, clock = { t0 })
            m.update(target)
            val last = LastUpdate(outcome = outcome, at = t0 + minute, targetCommit = target, previousCommit = current)
            assertTrue(outcome, m.reconcile(current, last))
            assertNull(outcome, store.get(server))
        }
    }

    @Test
    fun notClearedByAnOlderOrDifferentOutcome() = runTest {
        val store = InMemoryPendingUpdateStore()
        val m = vm(MockSecretMailboxClient(), currentCommit = current, store = store, clock = { t0 })
        m.update(target)
        // The verdict on a previous order for the same commit.
        assertFalse(m.reconcile(current, LastUpdate("refused", at = t0 - 1, targetCommit = target)))
        // A newer verdict for a different commit.
        assertFalse(m.reconcile(current, LastUpdate("applied", at = t0 + minute, targetCommit = "c".repeat(40))))
        // A refusal names no target, so only one recorded before the order is ignored.
        assertFalse(m.reconcile(current, LastUpdate("refused", at = t0 - minute)))
        assertTrue(m.pending.value != null)
        assertTrue(store.get(server) != null)
    }

    @Test
    fun staleAfterThirtyMinutes() {
        val p = PendingUpdate(target, null, current, t0)
        assertFalse(p.isStale(t0 + 29 * minute))
        assertTrue(p.isStale(t0 + 30 * minute))
        assertTrue(p.sentLine(t0 + 5 * minute).startsWith("Update to 9f2c1ab3 sent 5m ago."))
    }

    @Test
    fun sendAgainReordersTheSameTarget() = runTest {
        val store = InMemoryPendingUpdateStore()
        var clock = t0
        val mb = MockSecretMailboxClient()
        val m = vm(mb, currentCommit = current, store = store, clock = { clock })
        m.update(target, "v1.2.0")
        clock = t0 + 31 * minute
        assertTrue(m.sendAgain())
        assertEquals(2, mb.updateDeposits.size)
        assertEquals(target, mb.updateDeposits[1].second.order.targetCommit)
        assertEquals(current, mb.updateDeposits[1].second.order.fromCommit)
        assertEquals(PendingUpdate(target, "v1.2.0", current, clock), store.get(server))
        assertFalse(store.get(server)!!.isStale(clock))
    }

    @Test
    fun forgetClearsThePendingOrder() = runTest {
        val store = InMemoryPendingUpdateStore()
        val m = vm(MockSecretMailboxClient(), currentCommit = current, store = store)
        m.update(target)
        m.forget()
        assertNull(m.pending.value)
        assertNull(store.get(server))
        assertEquals(UpdateServerViewModel.Phase.Idle, m.phase.value)
        assertFalse(m.sendAgain())
    }

    @Test
    fun pendingIsPerServer() = runTest {
        val store = InMemoryPendingUpdateStore()
        val other = "work.alice.flagship.services"
        vm(MockSecretMailboxClient(), currentCommit = current, store = store).update(target)
        assertNull(store.get(other))
        val otherVm = vm(MockSecretMailboxClient(), currentCommit = current, store = store, serverFqdn = other)
        assertNull(otherVm.pending.value)
        otherVm.update(target)
        otherVm.forget()
        assertTrue(store.get(server) != null)
    }
}
