// "Update this server" — phone-ordered, dual-signed in-place update
// (docs/server-update-mechanism.md). Kotlin mirror of the iOS
// FlagshipUI/ViewModels/UpdateServerViewModel.swift.
//
// Behind the biometric, the admin signs a `flagship/server-update/v1`
// UpdateOrder naming THIS box + the target commit and deposits it on `.com`'s
// update lane (SecretMailboxClient.depositUpdate). This is the AUTHORIZATION
// half of the 2-of-2 gate only: the box re-verifies the order under its pinned
// admin master root AND separately requires the target commit to be
// maintainer-ENDORSED (the daemon's ReleaseGate) before applying — an order
// alone can never push unblessed code, and the box rolls back automatically if
// the new version fails its boot health gate.
//
// `fromCommit` is ALWAYS the box-reported `currentCommit` from server-detail —
// never a guess. Without it (old daemon / not a git checkout) the action is
// disabled.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.core.ServerUpdateDeposit
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class UpdateServerViewModel(
    private val username: String,
    private val serverFqdn: String,
    /** The box-reported running commit (server-detail `currentCommit`).
     *  null ⇒ the box hasn't reported ⇒ no order can be minted. */
    currentCommit: String?,
    private val mailbox: SecretMailboxClient,
    /** Derives the owner IRK behind one biometric. Injectable for tests. */
    private val signer: suspend (String) -> Ed25519Sign = { reason -> Keystore.deriveIRK(reason) },
    /** The owner IRK pub hex (for the mailbox auth). Injectable for tests. */
    private val irkPubHex: suspend () -> String = { Keystore.irkPubHex() },
    /** Slice D — resolves the ADMIN MASTER ROOT to sign the SENSITIVE update
     *  ORDER, or null when this device holds no admin root (legacy ⇒ the order
     *  stays IRK-signed). NEVER a bare-IRK default when a root exists — the
     *  `.com` gate rejects an IRK-signed order once a root is pinned. */
    private val orderSigner: suspend (String) -> Ed25519Sign? =
        { reason -> if (Keystore.hasAdminRoot()) Keystore.adminRootKey(reason) else null },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    sealed interface Phase {
        data object Idle : Phase
        data object Signing : Phase
        data object Posting : Phase
        data object Done : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    private val currentCommit: String? = currentCommit?.lowercase()

    /** True iff the box has reported a usable current commit — without it no
     *  order can be minted (`fromCommit` must be truth, never a guess). */
    val canUpdate: Boolean
        get() = currentCommit?.let(ServerUpdateDeposit::isValidCommit) == true

    /** The short display form of the running commit ("9f2c1ab3"), or null. */
    val runningShort: String?
        get() = currentCommit?.takeIf(ServerUpdateDeposit::isValidCommit)?.take(8)

    /** Client-side validation copy for the target field (mirrors iOS/webapp).
     *  Returns the failure copy, or null when the target is orderable. */
    fun targetProblem(raw: String): String? {
        val t = raw.trim().lowercase()
        if (t.isEmpty()) return null
        if (!ServerUpdateDeposit.isValidCommit(t)) {
            return "Enter the full 40-character commit hash of the blessed release."
        }
        if (t == currentCommit) return "The server is already running this release."
        return null
    }

    /** True iff `raw` names a complete, different, well-formed target. */
    fun canOrder(raw: String): Boolean {
        val t = raw.trim().lowercase()
        return canUpdate && ServerUpdateDeposit.isValidCommit(t) && t != currentCommit
    }

    /** Mint + sign + deposit the update order: biometric → sign → deposit.
     *  Returns true on success. */
    suspend fun update(targetCommit: String): Boolean {
        val from = currentCommit
        if (from == null || !ServerUpdateDeposit.isValidCommit(from)) {
            _phase.value = Phase.Failed("This server hasn't reported its current version yet.")
            return false
        }
        val target = targetCommit.trim().lowercase()
        if (!ServerUpdateDeposit.isValidCommit(target)) {
            _phase.value = Phase.Failed("Enter the full 40-character commit hash of the blessed release.")
            return false
        }
        if (target == from) {
            _phase.value = Phase.Failed("The server is already running this release.")
            return false
        }

        _phase.value = Phase.Signing
        return try {
            val reason = "Update $serverFqdn"
            val irk = signer(reason)
            val pub = irkPubHex()
            val orderKey = orderSigner(reason)
            val body = ServerUpdateDeposit.buildDeposit(
                username = username,
                serverDomain = serverFqdn,
                targetCommit = target,
                fromCommit = from,
                irk = irk,
                irkPubHex = pub,
                orderKey = orderKey,
                now = now(),
            )
            _phase.value = Phase.Posting
            mailbox.depositUpdate(serverFqdn, body)
            _phase.value = Phase.Done
            true
        } catch (t: Throwable) {
            _phase.value = Phase.Failed(t.message ?: "That didn't work. Try again in a moment.")
            false
        }
    }
}
