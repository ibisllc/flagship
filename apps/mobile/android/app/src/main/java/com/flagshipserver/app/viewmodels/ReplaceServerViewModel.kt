// "Replace this server" — graceful-decommission orchestrator (Android), the
// Kotlin mirror of iOS FlagshipUI/ViewModels/ReplaceServerViewModel.swift
// (docs/server-replacement-graceful-decommission.md).
//
// Mirrors the transfer-a-box giver flow + the lock-and-power flow:
//   1. PRE-FLIGHT backup gate (HARD): a box with no peer-backup enrolled loses
//      its data on replacement → block; only `wipe-now` (accept-loss) proceeds.
//   2. The owner picks a disk DISPOSITION (keep / wipe-after-handoff / wipe-now).
//   3. Mint + sign a ServerDecommission order (retiredStkPubHex = the box's
//      CURRENT STK from the directory) under the owner IRK behind the biometric,
//      then DEPOSIT it to <controlApex>/api/server/<domain>/decommission.
//   4. L3 — on success retire the box instance LOCALLY (remove the pod) so a
//      rebooting encrypted zombie is never re-surfaced for unlock approval.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.core.ReplaceServerFlow
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface ReplaceServerPhase {
    /** Checking peer-backup enrollment before anything else. */
    data object CheckingBackup : ReplaceServerPhase
    /** Backup enrolled → the owner picks a disposition + confirms. */
    data object Ready : ReplaceServerPhase
    /** No peer-backup enrolled → replacing loses data. Only `wipe-now`
     *  (accept-loss) may proceed from here. */
    data object BackupGate : ReplaceServerPhase
    data object Signing : ReplaceServerPhase
    data object Posting : ReplaceServerPhase
    /** Deposited + retired locally. [disposition] echoes what was ordered. */
    data class Completed(val disposition: ReplaceServerFlow.Disposition) : ReplaceServerPhase
    data class Failed(val message: String) : ReplaceServerPhase
}

class ReplaceServerViewModel(
    private val serverFqdn: String,
    private val username: String,
    private val mailbox: SecretMailboxClient,
    private val screens: ScreensClient,
    /** L3 — called on a successful deposit to retire the box instance locally. */
    private val onRetired: () -> Unit,
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val irkPubHex: suspend () -> String = { Keystore.irkPubHex() },
    /** Slice D — resolves the ADMIN MASTER ROOT to sign the SENSITIVE
     *  decommission ORDER, or null (legacy ⇒ IRK). The mailbox AUTH stays IRK. */
    private val orderSigner: suspend (reason: String) -> Ed25519Sign? =
        { r -> if (Keystore.hasAdminRoot()) Keystore.adminRootKey(r) else null },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val _phase = MutableStateFlow<ReplaceServerPhase>(ReplaceServerPhase.CheckingBackup)
    val phase: StateFlow<ReplaceServerPhase> = _phase.asStateFlow()

    /** True once the backup pre-flight has run and found NO enrolled peer-backup.
     *  Drives the gate copy; `wipe-now` is the only disposition that may proceed. */
    var backupMissing: Boolean = false
        private set

    /** Pre-flight: is peer-backup enrolled for this box? Conservatively, backup
     *  counts as enrolled ONLY when the box is participating AND at least one peer
     *  actually holds its data (`peersBackingYouUp`). Anything we can't confirm
     *  gates HARD (treat as "no backup"). */
    suspend fun preflight() {
        _phase.value = ReplaceServerPhase.CheckingBackup
        val enrolled = try {
            val status = screens.peerBackupStatus()
            status.participating && status.peersBackingYouUp.isNotEmpty()
        } catch (_: Throwable) {
            // TODO: the box BFF may not expose peerBackupStatus on every build /
            // un-rebuilt box (404 → "not set up"). Gate CONSERVATIVELY: an
            // unreadable backup signal blocks like "no backup", so a replacement
            // can never silently lose data on an unconfirmed box.
            false
        }
        if (enrolled) {
            backupMissing = false
            _phase.value = ReplaceServerPhase.Ready
        } else {
            backupMissing = true
            _phase.value = ReplaceServerPhase.BackupGate
        }
    }

    /** Mint + sign + deposit the decommission order, then L3-retire the box
     *  locally on success. When backup is missing, only `wipe-now` may proceed. */
    suspend fun replace(disposition: ReplaceServerFlow.Disposition) {
        if (backupMissing && disposition != ReplaceServerFlow.Disposition.WipeNow) {
            _phase.value = ReplaceServerPhase.Failed(
                "This server has no backup. Set up backup first, or choose “Wipe now” to replace it and accept the data loss.",
            )
            return
        }

        // Resolve the box's CURRENT STK from the directory BEFORE the biometric.
        // `retiredStkPubHex` is the load-bearing replay guard (I2); it must name
        // THIS instance. A box with no directory entry can't be decommissioned.
        val retiredStkPubHex: String = try {
            val pods = mailbox.fetchPods(username)
            pods.identityPubKey(serverFqdn) ?: run {
                _phase.value = ReplaceServerPhase.Failed(
                    "Couldn't find this box in your account directory. Refresh and try again.",
                )
                return
            }
        } catch (_: Throwable) {
            _phase.value = ReplaceServerPhase.Failed(
                "Couldn't reach your account directory. Check your connection and try again.",
            )
            return
        }

        _phase.value = ReplaceServerPhase.Signing
        val key: Ed25519Sign
        val pub: String
        val orderKey: Ed25519Sign?
        try {
            key = signer("Replace $serverFqdn")
            pub = irkPubHex()
            orderKey = orderSigner("Replace $serverFqdn")
        } catch (e: Throwable) {
            _phase.value = ReplaceServerPhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }

        // `keep` has no final flush; the wipe dispositions flush first when a
        // backup exists. With a missing backup there's nothing to flush.
        val finalBackup = disposition != ReplaceServerFlow.Disposition.Keep && !backupMissing

        val body = try {
            ReplaceServerFlow.buildDeposit(
                serverFqdn = serverFqdn,
                username = username,
                irk = key,
                irkPubHex = pub,
                orderKey = orderKey,
                retiredStkPubHex = retiredStkPubHex,
                finalBackup = finalBackup,
                disposition = disposition,
                issuedAt = now(),
            )
        } catch (e: Throwable) {
            _phase.value = ReplaceServerPhase.Failed("Couldn't sign the replacement order: ${e.message}")
            return
        }

        _phase.value = ReplaceServerPhase.Posting
        try {
            mailbox.depositDecommission(serverFqdn, body)
        } catch (e: Throwable) {
            _phase.value = ReplaceServerPhase.Failed("Couldn't reach the server directory: ${e.message}")
            return
        }

        // L3 — retire the instance locally so a rebooting encrypted zombie is
        // never re-surfaced for unlock approval.
        onRetired()
        _phase.value = ReplaceServerPhase.Completed(disposition)
    }
}
