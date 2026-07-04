// "Migrate to new hardware" — the server-migration orchestrator for the
// server-detail screen (docs/server-migration.md), the Kotlin mirror of iOS
// FlagshipUI/ViewModels/MigrationViewModel.swift. Same owner, same
// `<server>.<user>` name, NEW box.
//
// Two modes, mirroring the webapp dialog:
//   - no session → the admin-signed INITIATE ceremony (resolve the box's
//     CURRENT STK from the directory, disposition picker, backup pre-flight
//     gate, sign + deposit, record the SWK migration hold);
//   - live session → the 8-step progress timeline (5s poll while visible)
//     with the phase-appropriate action (hand off / abort).
//
// The migration ORDER/CONTROL are SENSITIVE (Slice D) → they sign with the
// admin master root when this device holds one, else the legacy owner IRK;
// the mailbox AUTH stays IRK-signed. The box STK is resolved from the
// directory BEFORE the biometric (same trust model as the Replace flow).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MigrationSession
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.core.MigrationHoldStore
import com.flagshipserver.app.core.ServerMigrationFlow
import com.flagshipserver.app.core.ServerMigrationTimeline
import com.flagshipserver.app.core.ServerTransferFlow
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive

sealed interface MigrationMode {
    data object Loading : MigrationMode
    /** No live session — show the initiate ceremony. */
    data object Initiate : MigrationMode
    /** A session exists — show the timeline (poll drives updates). */
    data object Progress : MigrationMode
    data class Failed(val message: String) : MigrationMode
}

class MigrationViewModel(
    val serverFqdn: String,
    private val username: String,
    private val mailbox: SecretMailboxClient,
    private val screens: ScreensClient,
    private val holdStore: MigrationHoldStore,
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val irkPubHex: suspend () -> String = { Keystore.irkPubHex() },
    /** Slice D — resolves the ADMIN MASTER ROOT to sign the SENSITIVE
     *  migration ORDER/CONTROL, or null (legacy ⇒ IRK). The mailbox AUTH
     *  stays IRK. */
    private val orderSigner: suspend (reason: String) -> Ed25519Sign? =
        { r -> if (Keystore.hasAdminRoot()) Keystore.adminRootKey(r) else null },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val randomNonce: () -> ByteArray = { ServerTransferFlow.random32() },
    private val pollIntervalMs: Long = 5_000,
) {
    private val _mode = MutableStateFlow<MigrationMode>(MigrationMode.Loading)
    val mode: StateFlow<MigrationMode> = _mode.asStateFlow()

    private val _session = MutableStateFlow<MigrationSession?>(null)
    val session: StateFlow<MigrationSession?> = _session.asStateFlow()

    private val _disposition = MutableStateFlow(ServerMigrationFlow.DEFAULT_DISPOSITION)
    val disposition: StateFlow<ServerMigrationFlow.Disposition> = _disposition.asStateFlow()

    private val _working = MutableStateFlow(false)
    val working: StateFlow<Boolean> = _working.asStateFlow()

    /** Inline error surfaced next to the action (the mode stays usable). */
    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    /** True once the backup pre-flight found NO enrolled peer-backup. The
     *  restore rides peer-backup, so a no-backup box can only migrate with
     *  `keep` (the old disk remains the fallback copy) — same fail-closed
     *  posture as the Replace pre-flight gate. */
    var backupMissing: Boolean = false
        private set

    /** The migrating box's CURRENT STK from the directory (null ⇒ can't start). */
    var oldStkPubHex: String? = null
        private set

    fun setDisposition(d: ServerMigrationFlow.Disposition) {
        _disposition.value = d
    }

    // ── Timeline projection ───────────────────────────────────────────────────

    val steps: List<ServerMigrationTimeline.Step>
        get() = _session.value?.let { ServerMigrationTimeline.steps(it) } ?: emptyList()

    val waitCopy: String
        get() = _session.value?.let { ServerMigrationTimeline.waitCopy(it, now()) } ?: ""

    /** Abort is offered at every pre-take-over step — everything before
     *  take-over aborts cleanly (the old box stays authoritative with all its
     *  data); `.com` 409s after (the point of no return). */
    val canAbort: Boolean
        get() = _session.value?.let { it.abortedAt == null && it.takenOverAt == null } ?: false

    val isTerminal: Boolean
        get() = _session.value?.let { it.done || it.abortedAt != null } ?: false

    /** The wipe-after-handoff gate (mirrors the Replace pre-flight posture). */
    val startBlocked: Boolean
        get() = (_disposition.value == ServerMigrationFlow.Disposition.WipeAfterHandoff && backupMissing) ||
            oldStkPubHex == null

    // ── Load / poll ───────────────────────────────────────────────────────────

    /** An in-flight session wins — render its timeline. Otherwise resolve the
     *  initiate context (STK + backup signal) before offering the ceremony. */
    suspend fun load() {
        _mode.value = MigrationMode.Loading
        val existing = try {
            mailbox.fetchMigration(serverFqdn)
        } catch (_: Throwable) {
            _mode.value = MigrationMode.Failed(
                "Couldn't check for a migration in progress. Check your connection and try again.",
            )
            return
        }
        if (existing != null && existing.abortedAt == null) {
            _session.value = existing
            reconcileHold(existing)
            _mode.value = MigrationMode.Progress
            return
        }
        prepareInitiate()
    }

    private suspend fun prepareInitiate() {
        try {
            val pods = mailbox.fetchPods(username)
            val stk = pods.identityPubKey(serverFqdn)
            if (stk == null) {
                _mode.value = MigrationMode.Failed(
                    "Couldn't read this box's current key from the directory — is it online? It must be reachable to migrate.",
                )
                return
            }
            oldStkPubHex = stk
        } catch (_: Throwable) {
            _mode.value = MigrationMode.Failed(
                "Couldn't reach your account directory. Check your connection and try again.",
            )
            return
        }
        backupMissing = try {
            val status = screens.peerBackupStatus()
            !(status.participating && status.peersBackingYouUp.isNotEmpty())
        } catch (_: Throwable) {
            // An unreadable backup signal gates CONSERVATIVELY, like the
            // Replace pre-flight — wipe-after-handoff stays blocked.
            true
        }
        _mode.value = MigrationMode.Initiate
    }

    /** One poll tick. Transient errors keep the last render. */
    suspend fun refresh() {
        val s = try {
            mailbox.fetchMigration(serverFqdn)
        } catch (_: Throwable) {
            return
        } ?: return
        _session.value = s
        reconcileHold(s)
        if (_mode.value != MigrationMode.Progress) _mode.value = MigrationMode.Progress
    }

    /** Poll while the screen is visible — run from a LaunchedEffect so
     *  Compose cancels it on dispose. */
    suspend fun pollLoop() {
        while (currentCoroutineContext().isActive &&
            _mode.value == MigrationMode.Progress && !isTerminal
        ) {
            delay(pollIntervalMs)
            refresh()
        }
    }

    private fun reconcileHold(s: MigrationSession) {
        // Terminal ⇒ the SWK hold is moot: aborted keeps the old box, and at
        // take-over the directory identity is already rebound to the new box.
        if (s.abortedAt != null || s.takenOverAt != null) {
            holdStore.clearHold(serverFqdn)
        }
    }

    // ── Initiate (phase 1) ────────────────────────────────────────────────────

    suspend fun start() {
        _errorMessage.value = null
        val oldStk = oldStkPubHex
        if (oldStk == null) {
            _errorMessage.value = "Couldn't read this box's current key — refresh and try again."
            return
        }
        if (_disposition.value == ServerMigrationFlow.Disposition.WipeAfterHandoff && backupMissing) {
            _errorMessage.value =
                "This server has no backup — enable backup first, or keep the old disk as the fallback."
            return
        }
        _working.value = true
        try {
            val reason = "Migrate $serverFqdn to new hardware"
            val irk = signer(reason)
            val pub = irkPubHex()
            val orderKey = orderSigner(reason)
            val body = ServerMigrationFlow.buildStartDeposit(
                serverFqdn = serverFqdn,
                username = username,
                irk = irk,
                irkPubHex = pub,
                orderKey = orderKey,
                oldStkPubHex = oldStk,
                disposition = _disposition.value,
                issuedAt = now(),
                nonce = randomNonce(),
                authNonce = randomNonce(),
            )
            mailbox.depositMigrationStart(serverFqdn, body)
        } catch (e: Throwable) {
            _errorMessage.value = "Couldn't start the migration: ${e.message}"
            return
        } finally {
            _working.value = false
        }
        // The SWK hold makes the NEXT added pod's SWK deposit migration-aware
        // (MigrationSwkResolver, consulted by SwkDepositCoordinator).
        holdStore.setHold(serverFqdn)
        _mode.value = MigrationMode.Progress
        refresh()
    }

    // ── Hand off (phases 4+5) ─────────────────────────────────────────────────

    /** Confirm-ready + freeze under ONE biometric ceremony (two signatures,
     *  one user tap — mirrors the webapp: the confirm is the health checkpoint
     *  the user is looking at right now, and splitting them into two
     *  ceremonies adds a prompt without adding safety; the machine still
     *  enforces pre-seeded → ready → freezing server-side). If the freeze half
     *  fails after confirm-ready landed, the next poll shows `ready` and the
     *  button becomes a freeze-only retry. */
    suspend fun handOff() {
        val s = _session.value ?: return
        _errorMessage.value = null
        _working.value = true
        try {
            val reason = "Hand $serverFqdn off to the new box"
            val irk = signer(reason)
            val pub = irkPubHex()
            val orderKey = orderSigner(reason)
            if (s.phase == "pre-seeded") {
                val confirm = ServerMigrationFlow.buildControlDeposit(
                    action = "confirm-ready",
                    serverFqdn = serverFqdn,
                    username = username,
                    irk = irk,
                    irkPubHex = pub,
                    orderKey = orderKey,
                    issuedAt = now(),
                    nonce = randomNonce(),
                    authNonce = randomNonce(),
                )
                mailbox.depositMigrationConfirmReady(serverFqdn, confirm)
            }
            val freeze = ServerMigrationFlow.buildFreezeDeposit(
                serverFqdn = serverFqdn,
                username = username,
                irk = irk,
                irkPubHex = pub,
                orderKey = orderKey,
                oldStkPubHex = s.oldStkPubHex,
                disposition = s.disposition,
                issuedAt = now(),
                nonce = randomNonce(),
                authNonce = randomNonce(),
            )
            mailbox.depositMigrationFreeze(serverFqdn, freeze)
        } catch (e: Throwable) {
            _errorMessage.value = "Couldn't hand off: ${e.message}"
        } finally {
            _working.value = false
        }
        // CUTOVER (client side of phase 6/7): after `takenOverAt` there is NO
        // client RCK re-point — no surface persists the RCK private key (it is
        // minted at create, the pub registered, the private half discarded),
        // so a SetRoutingTarget cannot be signed. The `.com` take-over handler
        // rebinds the directory identity server-side, and the hub's eviction +
        // the new box's HELLO claim move the live route. Cert re-pin is
        // automatic: the migrated box re-derives the SAME status STK (the SWK
        // is unchanged across migration), so its first verified daemon-status
        // report REPLACES the old fingerprint pin in CertPinRegistry.update.
        refresh()
    }

    // ── Abort ─────────────────────────────────────────────────────────────────

    suspend fun abort() {
        _errorMessage.value = null
        _working.value = true
        try {
            val reason = "Abort migrating $serverFqdn"
            val irk = signer(reason)
            val pub = irkPubHex()
            val orderKey = orderSigner(reason)
            val body = ServerMigrationFlow.buildControlDeposit(
                action = "abort",
                serverFqdn = serverFqdn,
                username = username,
                irk = irk,
                irkPubHex = pub,
                orderKey = orderKey,
                issuedAt = now(),
                nonce = randomNonce(),
                authNonce = randomNonce(),
            )
            mailbox.depositMigrationAbort(serverFqdn, body)
            holdStore.clearHold(serverFqdn)
        } catch (e: Throwable) {
            _errorMessage.value = "Couldn't abort: ${e.message}"
        } finally {
            _working.value = false
        }
        refresh()
    }
}
