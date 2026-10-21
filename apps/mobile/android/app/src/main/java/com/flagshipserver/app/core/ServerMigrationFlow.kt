// Pure (JVM-testable) builders for the "Migrate to new machine / VM" flow
// (docs/server-migration.md) — the exact wire bodies the `.com` migration lane
// accepts, byte-identical to the webapp lib/serverMigration.js + iOS
// FlagshipCore ServerMigrationFlow. The Compose VM derives the keys behind the
// biometric, then calls these.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
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
            Triple("initiate", FSStrings.get(R.string.migration_authorized), s.initiatedAt),
            Triple("provision", FSStrings.get(R.string.new_server_online_attached), s.attachedAt),
            Triple("pre-seed", FSStrings.get(R.string.data_restored_to_the_new_server), s.preSeededAt),
            Triple("ready", FSStrings.get(R.string.confirmed_ready_to_take_over), s.readyAt),
            Triple("freeze", FSStrings.get(R.string.old_server_frozen_final_backup), s.freezeAt),
            Triple("final-delta", FSStrings.get(R.string.final_backup_flushed), s.finalDeltaAt),
            Triple("take-over", FSStrings.get(R.string.new_server_took_over_the_name), s.takenOverAt),
            Triple("close-out", FSStrings.get(R.string.old_server_closed_out), s.oldClosedOutAt),
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
            return FSStrings.get(R.string.migration_aborted_your_old_server_stays)
        }
        if (s.done) return FSStrings.get(R.string.migration_complete_the_server_now_runs)
        return when (s.phase) {
            "initiated" ->
                FSStrings.get(R.string.waiting_for_the_new_server_to)
            "provisioned" -> {
                val attachedAt = s.attachedAt
                if (attachedAt != null && nowMs - attachedAt > PRE_SEED_STUCK_MS) {
                    FSStrings.get(R.string.the_new_server_attached_but_hasnt)
                } else {
                    FSStrings.get(R.string.new_server_attached_restoring_this_servers)
                }
            }
            "pre-seeded" ->
                FSStrings.get(R.string.data_restored_confirm_the_hand_off)
            "ready" ->
                FSStrings.get(R.string.ready_freeze_the_old_server_to)
            "freezing" ->
                if (s.finalDeltaAt == null) {
                    FSStrings.get(R.string.old_server_is_frozen_and_flushing)
                } else {
                    FSStrings.get(R.string.final_backup_flushed_the_new_server)
                }
            "taken-over" ->
                FSStrings.get(R.string.the_new_server_is_serving_the)
            else -> ""
        }
    }
}
