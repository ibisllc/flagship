// "Replace this server" graceful-decommission VM logic (Android). Drives the VM
// against MockSecretMailboxClient + MockScreensClient, asserting the backup
// pre-flight gate, the signed decommission wire body the broker accepts, and the
// L3 local retire. JVM-testable (injected signer/pub — no Android keystore).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PeerBackupPeerHostingYou
import com.flagshipserver.app.api.PeerBackupRepairStatus
import com.flagshipserver.app.api.PeerBackupStats
import com.flagshipserver.app.api.PeerBackupStatusResponse
import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.ReplaceServerFlow
import com.flagshipserver.app.core.ServerDecommissionOrder
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplaceServerViewModelTest {
    private val server = "home.alice.flagship.services"
    private val username = "alice"
    private val stkHex = "ab".repeat(32)
    private val kp = Ed25519Sign.KeyPair.newKeyPair()

    private val signer: suspend (String) -> Ed25519Sign = { Ed25519Sign(kp.privateKey) }
    private val pub: suspend () -> String = { HexUtil.encode(kp.publicKey) }

    private fun mailboxWithDirectory() = MockSecretMailboxClient().apply {
        directory = listOf(PodDirectoryEntry(serverDomain = server, identityPubKey = stkHex))
    }

    private fun enrolledBackupScreens() = MockScreensClient().apply {
        peerBackupStatusFixture = PeerBackupStatusResponse(
            participating = true,
            peersBackingYouUp = listOf(PeerBackupPeerHostingYou("peer.bob.flagship.services", 3, 1L, true)),
            peersYouBackUp = emptyList(),
            shards = emptyList(),
            repair = PeerBackupRepairStatus("idle", null, 0, 0, null),
            stats = PeerBackupStats(3, 3, 0, 100L, 0L),
        )
    }

    private fun vm(
        mailbox: MockSecretMailboxClient,
        screens: MockScreensClient,
        onRetired: () -> Unit = {},
    ) = ReplaceServerViewModel(
        serverFqdn = server, username = username, mailbox = mailbox, screens = screens,
        onRetired = onRetired, signer = signer, irkPubHex = pub, now = { 1700 },
    )

    // ── Pre-flight backup gate ────────────────────────────────────────────────

    @Test
    fun preflightWithEnrolledBackupGoesReady() = runTest {
        val vm = vm(mailboxWithDirectory(), enrolledBackupScreens())
        vm.preflight()
        assertEquals(ReplaceServerPhase.Ready, vm.phase.value)
        assertFalse(vm.backupMissing)
    }

    @Test
    fun preflightWithNoBackupGatesHard() = runTest {
        // Default mock screens returns participating:false → gate.
        val vm = vm(mailboxWithDirectory(), MockScreensClient())
        vm.preflight()
        assertEquals(ReplaceServerPhase.BackupGate, vm.phase.value)
        assertTrue(vm.backupMissing)
    }

    @Test
    fun participatingButNoPeersStillGates() = runTest {
        val screens = MockScreensClient().apply {
            peerBackupStatusFixture = PeerBackupStatusResponse(
                participating = true, peersBackingYouUp = emptyList(), peersYouBackUp = emptyList(),
                shards = emptyList(), repair = PeerBackupRepairStatus("idle", null, 0, 0, null),
                stats = PeerBackupStats(0, 0, 0, 0L, 0L),
            )
        }
        val vm = vm(mailboxWithDirectory(), screens)
        vm.preflight()
        assertEquals(ReplaceServerPhase.BackupGate, vm.phase.value)
    }

    // ── Mint → sign → deposit body + L3 ───────────────────────────────────────

    @Test
    fun replaceMintsSignsAndDepositsVerifiableOrderAndRetires() = runTest {
        val mb = mailboxWithDirectory()
        var retired = false
        val vm = vm(mb, enrolledBackupScreens(), onRetired = { retired = true })
        vm.preflight()
        vm.replace(ReplaceServerFlow.Disposition.WipeAfterHandoff)

        assertEquals(ReplaceServerPhase.Completed(ReplaceServerFlow.Disposition.WipeAfterHandoff), vm.phase.value)
        assertEquals(1, mb.decommissionDeposits.size)
        val (domain, body) = mb.decommissionDeposits[0]
        assertEquals(server, domain)
        assertEquals(server, body.order.podCanonical)
        assertEquals(stkHex, body.order.retiredStkPubHex)
        assertEquals("wipe-after-handoff", body.order.diskDisposition)
        assertTrue(body.order.finalBackup)
        assertEquals(1700L, body.order.backupEpoch)
        assertEquals(1700L, body.order.issuedAt)

        // The deposited signature verifies against the EXACT canonical bytes.
        Ed25519Verify(kp.publicKey).verify(
            HexUtil.decode(body.signature)!!,
            ServerDecommissionOrder.canonicalBytes(
                podCanonical = body.order.podCanonical,
                retiredStkPubHex = body.order.retiredStkPubHex,
                finalBackup = body.order.finalBackup,
                diskDisposition = body.order.diskDisposition,
                backupEpoch = body.order.backupEpoch,
                nonce = body.order.nonce,
                issuedAt = body.order.issuedAt,
            ),
        )
        // L3 — the box instance was retired locally on success.
        assertTrue(retired)
    }

    @Test
    fun keepDispositionDoesNotFinalBackup() = runTest {
        val mb = mailboxWithDirectory()
        val vm = vm(mb, enrolledBackupScreens())
        vm.preflight()
        vm.replace(ReplaceServerFlow.Disposition.Keep)
        assertEquals(1, mb.decommissionDeposits.size)
        assertFalse(mb.decommissionDeposits[0].second.order.finalBackup)
    }

    // ── Gate backstop + failure paths ─────────────────────────────────────────

    @Test
    fun noBackupBlocksNonWipeNow() = runTest {
        val mb = mailboxWithDirectory()
        var retired = false
        val vm = vm(mb, MockScreensClient(), onRetired = { retired = true })
        vm.preflight() // → BackupGate
        vm.replace(ReplaceServerFlow.Disposition.WipeAfterHandoff)
        assertTrue(vm.phase.value is ReplaceServerPhase.Failed)
        assertTrue(mb.decommissionDeposits.isEmpty())
        assertFalse(retired)
    }

    @Test
    fun noBackupAllowsWipeNowAcceptLoss() = runTest {
        val mb = mailboxWithDirectory()
        val vm = vm(mb, MockScreensClient())
        vm.preflight() // → BackupGate
        vm.replace(ReplaceServerFlow.Disposition.WipeNow)
        assertEquals(ReplaceServerPhase.Completed(ReplaceServerFlow.Disposition.WipeNow), vm.phase.value)
        assertEquals(1, mb.decommissionDeposits.size)
        // No backup → nothing to flush even on wipe-now.
        assertFalse(mb.decommissionDeposits[0].second.order.finalBackup)
    }

    @Test
    fun depositFailureSurfacesAndDoesNotRetire() = runTest {
        val mb = mailboxWithDirectory().apply { nextDecommissionError = HttpException(403, "no") }
        var retired = false
        val vm = vm(mb, enrolledBackupScreens(), onRetired = { retired = true })
        vm.preflight()
        vm.replace(ReplaceServerFlow.Disposition.WipeAfterHandoff)
        assertTrue(vm.phase.value is ReplaceServerPhase.Failed)
        assertFalse(retired)
    }

    @Test
    fun unknownBoxInDirectoryFailsWithoutSigning() = runTest {
        val mb = MockSecretMailboxClient() // empty directory
        var signed = false
        val vm = ReplaceServerViewModel(
            serverFqdn = server, username = username, mailbox = mb, screens = enrolledBackupScreens(),
            onRetired = {}, signer = { signed = true; Ed25519Sign(kp.privateKey) }, irkPubHex = pub, now = { 1700 },
        )
        vm.preflight()
        vm.replace(ReplaceServerFlow.Disposition.WipeAfterHandoff)
        assertTrue(vm.phase.value is ReplaceServerPhase.Failed)
        assertFalse(signed)
        assertTrue(mb.decommissionDeposits.isEmpty())
    }
}
