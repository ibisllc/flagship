// "Migrate to new hardware" orchestrator (docs/server-migration.md): the
// initiate ceremony (STK from the directory, backup gate, admin-signed order +
// SWK hold), the timeline poll, the one-tap hand-off (confirm-ready + freeze
// under one ceremony, freeze-only retry from `ready`), and abort. Mirror of
// iOS MigrationViewModelTests. JVM-testable (injected signers — no Android
// keystore); Robolectric only for the SharedPreferences-backed hold store.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MigrationSession
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PeerBackupPeerHostingYou
import com.flagshipserver.app.api.PeerBackupRepairStatus
import com.flagshipserver.app.api.PeerBackupStats
import com.flagshipserver.app.api.PeerBackupStatusResponse
import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.MigrationHoldStore
import com.flagshipserver.app.core.ServerDecommissionOrder
import com.flagshipserver.app.core.ServerMigrationControl
import com.flagshipserver.app.core.ServerMigrationFlow
import com.flagshipserver.app.core.ServerMigrationOrder
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class MigrationViewModelTest {
    private val server = "home.alice.flagship.services"
    private val username = "alice"
    private val stkHex = "ab".repeat(32)

    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })
    private val adminKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })

    private fun freshHoldStore(): MigrationHoldStore {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val prefs = ctx.getSharedPreferences("migrationHold.${System.nanoTime()}", Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
        return MigrationHoldStore(prefs)
    }

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

    private fun session(
        phase: String,
        newServerDomain: String? = null,
        takenOverAt: Long? = null,
        abortedAt: Long? = null,
        oldClosedOutAt: Long? = null,
        done: Boolean = false,
    ) = MigrationSession(
        serverDomain = server, phase = phase,
        disposition = "wipe-after-handoff", oldStkPubHex = stkHex,
        newServerDomain = newServerDomain,
        initiatedAt = 1L, takenOverAt = takenOverAt, abortedAt = abortedAt,
        oldClosedOutAt = oldClosedOutAt, done = done,
    )

    private fun vm(
        mailbox: MockSecretMailboxClient = mailboxWithDirectory(),
        screens: MockScreensClient = enrolledBackupScreens(),
        holdStore: MigrationHoldStore = freshHoldStore(),
        withAdminRoot: Boolean = false,
        onSign: () -> Unit = {},
    ) = MigrationViewModel(
        serverFqdn = server,
        username = username,
        mailbox = mailbox,
        screens = screens,
        holdStore = holdStore,
        signer = { onSign(); Ed25519Sign(irkKp.privateKey) },
        irkPubHex = { HexUtil.encode(irkKp.publicKey) },
        orderSigner = { if (withAdminRoot) Ed25519Sign(adminKp.privateKey) else null },
        now = { 1700 },
        randomNonce = { ByteArray(32) { 7 } },
    )

    // ── Load ──────────────────────────────────────────────────────────────────

    @Test
    fun loadWithNoSessionResolvesStkAndBackupAndOffersInitiate() = runTest {
        val vm = vm()
        vm.load()
        assertEquals(MigrationMode.Initiate, vm.mode.value)
        assertEquals(stkHex, vm.oldStkPubHex)
        assertFalse(vm.backupMissing)
        assertEquals(
            "wipe-after-handoff is the default",
            ServerMigrationFlow.Disposition.WipeAfterHandoff, vm.disposition.value,
        )
        assertFalse(vm.startBlocked)
    }

    @Test
    fun loadWithLiveSessionShowsProgress() = runTest {
        val mb = mailboxWithDirectory().apply {
            migrationSession = session("provisioned", newServerDomain = "attic.alice.flagship.services")
        }
        val vm = vm(mailbox = mb)
        vm.load()
        assertEquals(MigrationMode.Progress, vm.mode.value)
        assertEquals(8, vm.steps.size)
        assertTrue(vm.canAbort)
    }

    @Test
    fun loadWithUnknownBoxFails() = runTest {
        val vm = vm(mailbox = MockSecretMailboxClient()) // empty directory
        vm.load()
        assertTrue(vm.mode.value is MigrationMode.Failed)
    }

    @Test
    fun loadWithUnreachableComFails() = runTest {
        val mb = mailboxWithDirectory().apply { nextMigrationFetchError = HttpException(0, "offline") }
        val vm = vm(mailbox = mb)
        vm.load()
        assertTrue(vm.mode.value is MigrationMode.Failed)
    }

    @Test
    fun unreadableBackupSignalGatesConservatively() = runTest {
        // Default mock screens: participating:false ⇒ backup missing ⇒ the
        // default wipe-after-handoff disposition is blocked; keep is not.
        val vm = vm(screens = MockScreensClient())
        vm.load()
        assertEquals(MigrationMode.Initiate, vm.mode.value)
        assertTrue(vm.backupMissing)
        assertTrue(vm.startBlocked)
        vm.setDisposition(ServerMigrationFlow.Disposition.Keep)
        assertFalse("keep leaves the old disk as the fallback copy", vm.startBlocked)
    }

    // ── Initiate ──────────────────────────────────────────────────────────────

    @Test
    fun startDepositsAdminSignedOrderAndSetsHold() = runTest {
        val mb = mailboxWithDirectory()
        val holds = freshHoldStore()
        val vm = vm(mailbox = mb, holdStore = holds, withAdminRoot = true)
        vm.load()
        vm.start()

        assertEquals(1, mb.migrationStarts.size)
        val (domain, body) = mb.migrationStarts[0]
        assertEquals(server, domain)
        assertEquals(server, body.order.serverDomain)
        assertEquals("oldStk = the pod's current directory identity", stkHex, body.order.oldStkPubHex)
        assertEquals("wipe-after-handoff", body.order.diskDisposition)
        assertEquals(64, body.order.nonce.length)
        assertEquals(1700L, body.order.issuedAt)

        // Admin-root signature over the exact canonical bytes `.com` re-derives.
        Ed25519Verify(adminKp.publicKey).verify(
            HexUtil.decode(body.signature)!!,
            ServerMigrationOrder.canonicalBytes(
                body.order.serverDomain, body.order.oldStkPubHex,
                body.order.diskDisposition, body.order.nonce, body.order.issuedAt,
            ),
        )

        // The SWK hold makes the next added pod's deposit migration-aware.
        assertTrue(holds.hasHold(server))
        assertEquals(MigrationMode.Progress, vm.mode.value)
    }

    @Test
    fun startBlockedByBackupGateDoesNotSignOrDeposit() = runTest {
        val mb = mailboxWithDirectory()
        var signed = false
        val vm = vm(mailbox = mb, screens = MockScreensClient(), onSign = { signed = true })
        vm.load()
        vm.start()
        assertTrue("gate blocks the deposit", mb.migrationStarts.isEmpty())
        assertFalse("gate blocks BEFORE the biometric", signed)
        assertNotNull(vm.errorMessage.value)
        assertEquals(MigrationMode.Initiate, vm.mode.value)
    }

    @Test
    fun startFailureSurfacesWithoutHold() = runTest {
        val mb = mailboxWithDirectory().apply {
            nextMigrationStartError = HttpException(409, "a migration is already in progress for this server")
        }
        val holds = freshHoldStore()
        val vm = vm(mailbox = mb, holdStore = holds)
        vm.load()
        vm.start()
        assertNotNull(vm.errorMessage.value)
        assertFalse("no hold when the deposit was refused", holds.hasHold(server))
        assertEquals(MigrationMode.Initiate, vm.mode.value)
    }

    // ── Hand off (confirm-ready + freeze, ONE ceremony) ───────────────────────

    @Test
    fun handOffFromPreSeededSignsConfirmThenFreezeUnderOneCeremony() = runTest {
        val mb = mailboxWithDirectory().apply {
            migrationSession = session("pre-seeded", newServerDomain = "attic.alice.flagship.services")
        }
        var ceremonies = 0
        val vm = vm(mailbox = mb, withAdminRoot = true, onSign = { ceremonies += 1 })
        vm.load()
        vm.handOff()

        assertEquals("two signatures, ONE biometric ceremony", 1, ceremonies)
        assertEquals(1, mb.migrationConfirms.size)
        assertEquals(1, mb.migrationFreezes.size)

        val confirm = mb.migrationConfirms[0].second
        assertEquals("confirm-ready", confirm.control.action)
        Ed25519Verify(adminKp.publicKey).verify(
            HexUtil.decode(confirm.signature)!!,
            ServerMigrationControl.canonicalBytes(
                confirm.control.serverDomain, confirm.control.action,
                confirm.control.nonce, confirm.control.issuedAt,
            ),
        )

        // The freeze IS the existing decommission deposit, session-constrained:
        // targets the session's old STK, finalBackup forced, disposition matches.
        val freeze = mb.migrationFreezes[0].second
        assertEquals(server, freeze.order.podCanonical)
        assertEquals(stkHex, freeze.order.retiredStkPubHex)
        assertTrue(freeze.order.finalBackup)
        assertEquals("wipe-after-handoff", freeze.order.diskDisposition)
        Ed25519Verify(adminKp.publicKey).verify(
            HexUtil.decode(freeze.signature)!!,
            ServerDecommissionOrder.canonicalBytes(
                podCanonical = freeze.order.podCanonical,
                retiredStkPubHex = freeze.order.retiredStkPubHex,
                finalBackup = freeze.order.finalBackup,
                diskDisposition = freeze.order.diskDisposition,
                backupEpoch = freeze.order.backupEpoch,
                nonce = freeze.order.nonce,
                issuedAt = freeze.order.issuedAt,
            ),
        )
    }

    @Test
    fun handOffFromReadyIsFreezeOnlyRetry() = runTest {
        val mb = mailboxWithDirectory().apply {
            migrationSession = session("ready", newServerDomain = "attic.alice.flagship.services")
        }
        val vm = vm(mailbox = mb)
        vm.load()
        vm.handOff()
        assertTrue("ready ⇒ confirm already landed; retry the freeze alone", mb.migrationConfirms.isEmpty())
        assertEquals(1, mb.migrationFreezes.size)
    }

    @Test
    fun handOffFreezeFailureSurfacesAfterConfirmLanded() = runTest {
        val mb = mailboxWithDirectory().apply {
            migrationSession = session("pre-seeded", newServerDomain = "attic.alice.flagship.services")
            nextMigrationFreezeError = HttpException(409, "freeze requires a ready migration")
        }
        val vm = vm(mailbox = mb)
        vm.load()
        vm.handOff()
        assertEquals(1, mb.migrationConfirms.size)
        assertTrue(mb.migrationFreezes.isEmpty())
        assertNotNull(
            "the next poll shows `ready` and the button retries the freeze alone",
            vm.errorMessage.value,
        )
    }

    // ── Abort ─────────────────────────────────────────────────────────────────

    @Test
    fun abortDepositsControlAndClearsHold() = runTest {
        val mb = mailboxWithDirectory().apply {
            migrationSession = session("provisioned", newServerDomain = "attic.alice.flagship.services")
        }
        val holds = freshHoldStore()
        holds.setHold(server)
        val vm = vm(mailbox = mb, holdStore = holds)
        vm.load()
        assertTrue(vm.canAbort)
        vm.abort()
        assertEquals(1, mb.migrationAborts.size)
        assertEquals("abort", mb.migrationAborts[0].second.control.action)
        assertFalse(holds.hasHold(server))
    }

    @Test
    fun noAbortAfterTakeOver() = runTest {
        val mb = mailboxWithDirectory().apply {
            migrationSession = session(
                "taken-over", newServerDomain = "attic.alice.flagship.services", takenOverAt = 9,
            )
        }
        val vm = vm(mailbox = mb)
        vm.load()
        assertFalse("take-over is the point of no return", vm.canAbort)
    }

    @Test
    fun abortFailureSurfacesAndKeepsHold() = runTest {
        val mb = mailboxWithDirectory().apply {
            migrationSession = session("provisioned", newServerDomain = "attic.alice.flagship.services")
            nextMigrationAbortError = HttpException(409, "no")
        }
        val holds = freshHoldStore()
        holds.setHold(server)
        val vm = vm(mailbox = mb, holdStore = holds)
        vm.load()
        vm.abort()
        assertNotNull(vm.errorMessage.value)
        assertTrue(holds.hasHold(server))
    }

    // ── Terminal states clear the hold ────────────────────────────────────────

    @Test
    fun refreshOnTerminalSessionClearsHold() = runTest {
        val mb = mailboxWithDirectory().apply {
            migrationSession = session("provisioned", newServerDomain = "attic.alice.flagship.services")
        }
        val holds = freshHoldStore()
        holds.setHold(server)
        val vm = vm(mailbox = mb, holdStore = holds)
        vm.load()
        assertTrue(holds.hasHold(server))

        mb.migrationSession = session(
            "taken-over", newServerDomain = "attic.alice.flagship.services",
            takenOverAt = 9, oldClosedOutAt = 10, done = true,
        )
        vm.refresh()
        assertFalse(holds.hasHold(server))
        assertTrue(vm.isTerminal)
        assertFalse(vm.canAbort)
        assertNull(vm.errorMessage.value)
    }
}
