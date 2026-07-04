// "Update this server" VM logic (Android). Drives the VM against
// MockSecretMailboxClient, asserting the box-reported-commit gate, the target
// validation, the signed update wire body the `.com` lane accepts, and the
// admin-root-vs-IRK order signing. JVM-testable (injected signer/pub — no
// Android keystore).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockSecretMailboxClient
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
    ) = UpdateServerViewModel(
        username = username,
        serverFqdn = server,
        currentCommit = currentCommit,
        mailbox = mailbox,
        signer = { onSign(); Ed25519Sign(irkKp.privateKey) },
        irkPubHex = { HexUtil.encode(irkKp.publicKey) },
        orderSigner = { if (adminRoot) Ed25519Sign(adminKp.privateKey) else null },
        now = { 1700L },
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
}
