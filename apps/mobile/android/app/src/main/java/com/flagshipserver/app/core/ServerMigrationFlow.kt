// Pure (JVM-testable) builders for the "Migrate to new hardware" flow
// (docs/server-migration.md) — the exact wire bodies the `.com` migration lane
// accepts, byte-identical to the webapp lib/serverMigration.js + iOS
// FlagshipCore ServerMigrationFlow. The Compose VM derives the keys behind the
// biometric, then calls these.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.DecommissionDepositBody
import com.flagshipserver.app.api.MigrationControlBody
import com.flagshipserver.app.api.MigrationSession
import com.flagshipserver.app.api.MigrationStartBody
import com.google.crypto.tink.subtle.Ed25519Sign

object ServerMigrationFlow {

    /** Migration disk dispositions — deliberately EXCLUDES `wipe-now`
     *  (invariant 1: a migration must never destroy the only copy before the
     *  successor confirms). MUST match @flagship/protocol
     *  `MigrationDisposition`. */
    enum class Disposition(val wire: String) {
        Keep("keep"),
        WipeAfterHandoff("wipe-after-handoff"),
    }

    val DEFAULT_DISPOSITION = Disposition.WipeAfterHandoff

    class MigrationFlowException(message: String) : RuntimeException(message)

    /** Mint + sign the ServerMigrationOrder and wrap it with the IRK
     *  mailbox-auth into the initiate deposit body. The ORDER signs with the
     *  admin master root (`orderKey`) when supplied, else the IRK (legacy);
     *  the mailbox AUTH stays IRK-signed (the owner deposit credential). */
    fun buildStartDeposit(
        serverFqdn: String,
        username: String,
        irk: Ed25519Sign,
        irkPubHex: String,
        orderKey: Ed25519Sign? = null,
        oldStkPubHex: String,
        disposition: Disposition,
        issuedAt: Long,
        nonce: ByteArray = ServerTransferFlow.random32(),
        authNonce: ByteArray = ServerTransferFlow.random32(),
    ): MigrationStartBody {
        val nonceHex = HexUtil.encode(nonce)
        val loweredStk = oldStkPubHex.lowercase()
        val sig = (orderKey ?: irk).sign(
            ServerMigrationOrder.canonicalBytes(
                serverDomain = serverFqdn,
                oldStkPubHex = loweredStk,
                diskDisposition = disposition.wire,
                nonce = nonceHex,
                issuedAt = issuedAt,
            )
        )
        val auth = ServerTransferFlow.buildMailboxAuth(username, irk, irkPubHex, issuedAt, authNonce)
        return MigrationStartBody(
            auth = auth.auth,
            authSignature = auth.authSignature,
            order = MigrationStartBody.Order(
                serverDomain = serverFqdn,
                oldStkPubHex = loweredStk,
                diskDisposition = disposition.wire,
                nonce = nonceHex,
                issuedAt = issuedAt,
            ),
            signature = HexUtil.encode(sig),
        )
    }

    /** Mint + sign a confirm-ready / abort control deposit. */
    fun buildControlDeposit(
        action: String,
        serverFqdn: String,
        username: String,
        irk: Ed25519Sign,
        irkPubHex: String,
        orderKey: Ed25519Sign? = null,
        issuedAt: Long,
        nonce: ByteArray = ServerTransferFlow.random32(),
        authNonce: ByteArray = ServerTransferFlow.random32(),
    ): MigrationControlBody {
        val nonceHex = HexUtil.encode(nonce)
        val sig = (orderKey ?: irk).sign(
            ServerMigrationControl.canonicalBytes(
                serverDomain = serverFqdn,
                action = action,
                nonce = nonceHex,
                issuedAt = issuedAt,
            )
        )
        val auth = ServerTransferFlow.buildMailboxAuth(username, irk, irkPubHex, issuedAt, authNonce)
        return MigrationControlBody(
            auth = auth.auth,
            authSignature = auth.authSignature,
            control = MigrationControlBody.Control(
                serverDomain = serverFqdn,
                action = action,
                nonce = nonceHex,
                issuedAt = issuedAt,
            ),
            signature = HexUtil.encode(sig),
        )
    }

    /** Phase 5 — freeze: EXACTLY the graceful-decommission deposit (delegates
     *  to `ReplaceServerFlow.buildDeposit` — the canonical bytes are the
     *  existing `ServerDecommissionOrder`, never re-implemented). The order
     *  targets the session's OLD instance, ALWAYS carries a final backup (the
     *  final delta the new box restores before take-over — the freeze handler
     *  rejects a no-final-backup order), and must match the migration order's
     *  disposition. */
    fun buildFreezeDeposit(
        serverFqdn: String,
        username: String,
        irk: Ed25519Sign,
        irkPubHex: String,
        orderKey: Ed25519Sign? = null,
        oldStkPubHex: String,
        disposition: String,
        issuedAt: Long,
        nonce: ByteArray = ServerTransferFlow.random32(),
        authNonce: ByteArray = ServerTransferFlow.random32(),
    ): DecommissionDepositBody {
        val d = ReplaceServerFlow.Disposition.entries.firstOrNull { it.wire == disposition }
        if (d == null || d == ReplaceServerFlow.Disposition.WipeNow) {
            throw MigrationFlowException("invalid migration disposition: $disposition")
        }
        return ReplaceServerFlow.buildDeposit(
            serverFqdn = serverFqdn,
            username = username,
            irk = irk,
            irkPubHex = irkPubHex,
            orderKey = orderKey,
            retiredStkPubHex = oldStkPubHex.lowercase(),
            finalBackup = true,
            disposition = d,
            issuedAt = issuedAt,
            nonce = nonce,
            authNonce = authNonce,
        )
    }
}

/** The spec's 8-step timeline + honest waiting copy, mapped from the GET body —
 *  the Kotlin mirror of iOS `ServerMigrationTimeline` / the webapp's
 *  `migrationSteps` / `migrationWaitCopy`. */
object ServerMigrationTimeline {

    enum class StepState { DONE, ACTIVE, PENDING }

    data class Step(
        val key: String,
        val label: String,
        val at: Long?,
        val state: StepState,
    )

    /** Session phases in which the migration is live (mirror of the `.com` set). */
    val ACTIVE_PHASES = setOf("initiated", "provisioned", "pre-seeded", "ready", "freezing")

    /** How long an attached-but-not-pre-seeded session waits before we surface
     *  the "is backup enabled?" hint (the GET carries no manifest signal). */
    const val PRE_SEED_STUCK_MS: Long = 10 * 60_000

    /** Aborted sessions mark every un-stamped step pending (no "active" spinner
     *  on a dead machine). */
    fun steps(s: MigrationSession): List<Step> {
        val aborted = s.abortedAt != null
        val rows = listOf(
            Triple("initiate", "Migration authorized", s.initiatedAt),
            Triple("provision", "New box online + attached", s.attachedAt),
            Triple("pre-seed", "Data restored to the new box", s.preSeededAt),
            Triple("ready", "Confirmed ready to take over", s.readyAt),
            Triple("freeze", "Old server frozen — final backup", s.freezeAt),
            Triple("final-delta", "Final backup flushed", s.finalDeltaAt),
            Triple("take-over", "New box took over the name", s.takenOverAt),
            Triple("close-out", "Old box closed out", s.oldClosedOutAt),
        )
        var activeSeen = false
        return rows.map { (key, label, at) ->
            val state = when {
                at != null -> StepState.DONE
                aborted || activeSeen -> StepState.PENDING
                else -> {
                    activeSeen = true
                    StepState.ACTIVE
                }
            }
            Step(key, label, at, state)
        }
    }

    /** Honest waiting copy for the CURRENT wait, plus the stuck-pre-seed hint. */
    fun waitCopy(s: MigrationSession, nowMs: Long): String {
        if (s.abortedAt != null) {
            return "Migration aborted — your old server stays active with all its data."
        }
        if (s.done) return "Migration complete — the server now runs on the new box."
        return when (s.phase) {
            "initiated" ->
                "Waiting for the new box to come online. Apply the recipe on the new hardware; it will attach itself here."
            "provisioned" -> {
                val attachedAt = s.attachedAt
                if (attachedAt != null && nowMs - attachedAt > PRE_SEED_STUCK_MS) {
                    "The new box attached but hasn't restored any data yet. If this server has no backup enabled, enable backup first — the migration restores from it."
                } else {
                    "New box attached — restoring this server's data from backup. The old server keeps serving meanwhile."
                }
            }
            "pre-seeded" ->
                "Data restored. Confirm the hand-off when you're ready — the old server will briefly freeze writes while the name moves."
            "ready" ->
                "Ready — freeze the old server to flush the final backup and hand the name over."
            "freezing" ->
                if (s.finalDeltaAt == null) {
                    "Old server is frozen and flushing its final backup…"
                } else {
                    "Final backup flushed — the new box is applying it and claiming the name…"
                }
            "taken-over" ->
                "The new box is serving the name. Waiting for the old box to close out."
            else -> ""
        }
    }
}
