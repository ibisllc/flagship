// The ServerMigrationFlow deposit builders produce the exact `.com` wire
// bodies: admin-root order signature (orderKey ?: irk), IRK mailbox-auth, and
// a freeze deposit that REUSES the existing ServerDecommission canonical bytes
// with finalBackup forced on. Plus the 8-step timeline + waiting-copy mapping
// (mirror of iOS ServerMigrationFlowTests / ServerMigrationTimelineTests).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MigrationSession
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ServerMigrationFlowTest {
    private val server = "home.alice.flagship.services"
    private val username = "alice"
    private val oldStk = "ab".repeat(32)

    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })
    private val adminKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })
    private val irk = Ed25519Sign(irkKp.privateKey)
    private val irkPubHex = HexUtil.encode(irkKp.publicKey)
    private val admin = Ed25519Sign(adminKp.privateKey)

    private fun verifies(sig: ByteArray, bytes: ByteArray, pub: ByteArray): Boolean = try {
        Ed25519Verify(pub).verify(sig, bytes)
        true
    } catch (_: Throwable) {
        false
    }

    // ── Start deposit ─────────────────────────────────────────────────────────

    @Test
    fun startDepositSignsOrderUnderAdminRootAndAuthUnderIrk() {
        val body = ServerMigrationFlow.buildStartDeposit(
            serverFqdn = server, username = username,
            irk = irk, irkPubHex = irkPubHex, orderKey = admin,
            oldStkPubHex = "AB".repeat(32),
            disposition = ServerMigrationFlow.Disposition.WipeAfterHandoff,
            issuedAt = 1700L,
            nonce = ByteArray(32) { 7 },
            authNonce = ByteArray(32) { 8 },
        )
        assertEquals(server, body.order.serverDomain)
        assertEquals("old STK is lowercased onto the wire", oldStk, body.order.oldStkPubHex)
        assertEquals("wipe-after-handoff", body.order.diskDisposition)
        assertEquals("32-byte nonce hex", 64, body.order.nonce.length)
        assertEquals(1700L, body.order.issuedAt)

        // The order signature verifies under the ADMIN root over the exact
        // canonical bytes `.com` re-derives — and NOT under the IRK.
        val bytes = ServerMigrationOrder.canonicalBytes(
            body.order.serverDomain, body.order.oldStkPubHex,
            body.order.diskDisposition, body.order.nonce, body.order.issuedAt,
        )
        val sig = HexUtil.decode(body.signature)!!
        assertTrue(verifies(sig, bytes, adminKp.publicKey))
        assertFalse(verifies(sig, bytes, irkKp.publicKey))

        // The mailbox auth stays the IRK deposit credential.
        assertEquals(username, body.auth.username)
        assertEquals(irkPubHex, body.auth.phoneIrkPub)
        assertTrue(
            DeviceEndpointClaim.verify(
                signature = HexUtil.decode(body.authSignature)!!,
                irkPub = irkKp.publicKey,
                username = body.auth.username,
                endpointLabel = body.auth.endpointLabel,
                phoneIrkPubHex = body.auth.phoneIrkPub,
                issuedAt = body.auth.issuedAt,
                expiresAt = body.auth.expiresAt,
                nonceHex = body.auth.nonce,
            ),
        )
    }

    @Test
    fun startDepositFallsBackToIrkWithoutAdminRoot() {
        val body = ServerMigrationFlow.buildStartDeposit(
            serverFqdn = server, username = username,
            irk = irk, irkPubHex = irkPubHex, orderKey = null,
            oldStkPubHex = oldStk,
            disposition = ServerMigrationFlow.Disposition.Keep,
            issuedAt = 1700L,
            nonce = ByteArray(32) { 7 },
            authNonce = ByteArray(32) { 8 },
        )
        assertEquals("keep", body.order.diskDisposition)
        val bytes = ServerMigrationOrder.canonicalBytes(
            body.order.serverDomain, body.order.oldStkPubHex,
            body.order.diskDisposition, body.order.nonce, body.order.issuedAt,
        )
        assertTrue(verifies(HexUtil.decode(body.signature)!!, bytes, irkKp.publicKey))
    }

    // ── Control deposit ───────────────────────────────────────────────────────

    @Test
    fun controlDepositCarriesActionAndVerifies() {
        val body = ServerMigrationFlow.buildControlDeposit(
            action = "confirm-ready",
            serverFqdn = server, username = username,
            irk = irk, irkPubHex = irkPubHex, orderKey = admin,
            issuedAt = 1800L,
            nonce = ByteArray(32) { 3 },
            authNonce = ByteArray(32) { 4 },
        )
        assertEquals("confirm-ready", body.control.action)
        val bytes = ServerMigrationControl.canonicalBytes(
            body.control.serverDomain, body.control.action,
            body.control.nonce, body.control.issuedAt,
        )
        assertTrue(verifies(HexUtil.decode(body.signature)!!, bytes, adminKp.publicKey))
    }

    // ── Freeze deposit ────────────────────────────────────────────────────────

    @Test
    fun freezeDepositReusesDecommissionCanonicalWithFinalBackupForced() {
        val body = ServerMigrationFlow.buildFreezeDeposit(
            serverFqdn = server, username = username,
            irk = irk, irkPubHex = irkPubHex, orderKey = null,
            oldStkPubHex = "AB".repeat(32),
            disposition = "wipe-after-handoff",
            issuedAt = 1700L,
            nonce = ByteArray(32) { 7 },
            authNonce = ByteArray(32) { 8 },
        )
        // The freeze handler's session constraints, satisfied by construction:
        // targets the old instance (lowercased), finalBackup === true,
        // disposition matches.
        assertEquals(oldStk, body.order.retiredStkPubHex)
        assertTrue("the final delta IS the point of the freeze", body.order.finalBackup)
        assertEquals("wipe-after-handoff", body.order.diskDisposition)

        // The signature is the EXISTING ServerDecommissionOrder canonical —
        // no migration-specific re-implementation.
        val bytes = ServerDecommissionOrder.canonicalBytes(
            podCanonical = body.order.podCanonical,
            retiredStkPubHex = body.order.retiredStkPubHex,
            finalBackup = body.order.finalBackup,
            diskDisposition = body.order.diskDisposition,
            backupEpoch = body.order.backupEpoch,
            nonce = body.order.nonce,
            issuedAt = body.order.issuedAt,
        )
        assertTrue(verifies(HexUtil.decode(body.signature)!!, bytes, irkKp.publicKey))
    }

    @Test
    fun freezeDepositRejectsWipeNowAndJunkDispositions() {
        for (bad in listOf("wipe-now", "nuke", "")) {
            try {
                ServerMigrationFlow.buildFreezeDeposit(
                    serverFqdn = server, username = username,
                    irk = irk, irkPubHex = irkPubHex, orderKey = null,
                    oldStkPubHex = oldStk, disposition = bad,
                    issuedAt = 1700L,
                    nonce = ByteArray(32) { 7 },
                    authNonce = ByteArray(32) { 8 },
                )
                fail("disposition $bad must be rejected")
            } catch (_: ServerMigrationFlow.MigrationFlowException) {
                // expected
            }
        }
    }
}

/** The 8-step timeline + waiting-copy mapping (mirror of iOS
 *  ServerMigrationTimelineTests / the webapp's migrationSteps /
 *  migrationWaitCopy). */
class ServerMigrationTimelineTest {
    private fun session(
        phase: String,
        initiatedAt: Long? = 1L,
        attachedAt: Long? = null,
        preSeededAt: Long? = null,
        readyAt: Long? = null,
        freezeAt: Long? = null,
        finalDeltaAt: Long? = null,
        takenOverAt: Long? = null,
        abortedAt: Long? = null,
        oldClosedOutAt: Long? = null,
        done: Boolean = false,
    ) = MigrationSession(
        serverDomain = "home.alice.flagship.services", phase = phase,
        disposition = "wipe-after-handoff", oldStkPubHex = "ab".repeat(32),
        initiatedAt = initiatedAt, attachedAt = attachedAt, preSeededAt = preSeededAt,
        readyAt = readyAt, freezeAt = freezeAt, finalDeltaAt = finalDeltaAt,
        takenOverAt = takenOverAt, abortedAt = abortedAt, oldClosedOutAt = oldClosedOutAt,
        done = done,
    )

    @Test
    fun stepsMarkDoneActivePendingInOrder() {
        val steps = ServerMigrationTimeline.steps(session(phase = "provisioned", attachedAt = 2))
        assertEquals(8, steps.size)
        assertEquals(ServerMigrationTimeline.StepState.DONE, steps[0].state)   // initiate
        assertEquals(ServerMigrationTimeline.StepState.DONE, steps[1].state)   // provision
        // pre-seed — the ONE active step.
        assertEquals(ServerMigrationTimeline.StepState.ACTIVE, steps[2].state)
        assertTrue(steps.drop(3).all { it.state == ServerMigrationTimeline.StepState.PENDING })
    }

    @Test
    fun abortedSessionHasNoActiveStep() {
        val steps = ServerMigrationTimeline.steps(session(phase = "aborted", abortedAt = 9))
        assertFalse(steps.any { it.state == ServerMigrationTimeline.StepState.ACTIVE })
    }

    @Test
    fun waitCopyHonestPerPhase() {
        assertTrue(
            ServerMigrationTimeline.waitCopy(session(phase = "initiated"), 10)
                .contains("Waiting for the new box"),
        )
        assertTrue(
            ServerMigrationTimeline.waitCopy(session(phase = "pre-seeded", attachedAt = 2, preSeededAt = 3), 10)
                .contains("Confirm the hand-off"),
        )
        assertTrue(
            ServerMigrationTimeline.waitCopy(session(phase = "aborted", abortedAt = 9), 10)
                .contains("old server stays active"),
        )
        assertTrue(
            ServerMigrationTimeline.waitCopy(session(phase = "taken-over", takenOverAt = 8, done = true), 10)
                .contains("Migration complete"),
        )
        assertNotNull(ServerMigrationTimeline.waitCopy(session(phase = "ready", readyAt = 4), 10))
    }

    @Test
    fun stuckPreSeedHintAfterTenMinutes() {
        val s = session(phase = "provisioned", attachedAt = 1_000)
        val fresh = ServerMigrationTimeline.waitCopy(s, 1_000 + 60_000)
        assertFalse(fresh.contains("enable backup first"))
        val stuck = ServerMigrationTimeline.waitCopy(s, 1_000 + ServerMigrationTimeline.PRE_SEED_STUCK_MS + 1)
        assertTrue(stuck.contains("enable backup first"))
    }

    @Test
    fun freezingCopyFlipsOnFinalDelta() {
        val flushing = session(phase = "freezing", freezeAt = 5)
        assertTrue(ServerMigrationTimeline.waitCopy(flushing, 10).contains("flushing"))
        val flushed = session(phase = "freezing", freezeAt = 5, finalDeltaAt = 6)
        assertTrue(ServerMigrationTimeline.waitCopy(flushed, 10).contains("claiming the name"))
    }
}
