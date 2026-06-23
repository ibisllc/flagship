// "Set as preferred server" owner vote (per-service leadership Phase 6,
// docs/multi-pod-liveness-session-leadership.md). Kotlin mirror of the iOS
// FlagshipUI/ViewModels/SetPreferredServerViewModel.swift.
//
// Behind the standard biometric, the owner signs the existing
// `flagship/set-leader/v1` vote for the selected pod's STK and deposits it on
// `.com`'s `set-leader` lane (SecretMailboxClient.depositSetLeader). The box
// fetches the vote and rides it on its gossip frame (clout); the highest-clout
// live runner of each service leads it. The UI marks the designated pod
// "preferred" IMMEDIATELY (via AppState.setLeader), independent of the box-side
// gossip catch-up.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.SetLeaderDeposit
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class SetPreferredServerViewModel(
    private val username: String,
    private val serverDomain: String,
    /** The chosen box's STK (32-byte hex) — the `preferredStkPubHex` the vote
     *  names. Empty/invalid ⇒ the pod has no registered STK yet (vote can't be
     *  cast). */
    private val preferredStkPubHex: String,
    private val mailbox: SecretMailboxClient,
    /** Derives the owner IRK behind one biometric. Injectable so tests don't hit
     *  the Keystore/biometric. */
    private val signer: suspend (String) -> Ed25519Sign = { reason -> Keystore.deriveIRK(reason) },
    /** The owner IRK pub hex (for the mailbox auth). Injectable for tests. */
    private val irkPubHex: suspend () -> String = { Keystore.irkPubHex() },
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

    /** True iff a vote can be cast (the pod has a registered STK). */
    val canVote: Boolean
        get() = HexUtil.decode(preferredStkPubHex)?.size == 32

    /** Cast the preferred-server vote: biometric → sign → deposit. Returns true
     *  on success so the caller can mark the pod preferred locally. */
    suspend fun setPreferred(): Boolean {
        if (!canVote) {
            _phase.value = Phase.Failed("This server has no registered identity yet.")
            return false
        }
        _phase.value = Phase.Signing
        return try {
            val irk = signer("Set $serverDomain as your preferred server")
            val pub = irkPubHex()
            val body = SetLeaderDeposit.buildDeposit(
                username = username,
                serverDomain = serverDomain,
                preferredStkPubHex = preferredStkPubHex,
                irk = irk,
                irkPubHex = pub,
                now = now(),
            )
            _phase.value = Phase.Posting
            mailbox.depositSetLeader(serverDomain, body)
            _phase.value = Phase.Done
            true
        } catch (_: Throwable) {
            _phase.value = Phase.Failed("Couldn't set the preferred server. Please try again.")
            false
        }
    }
}
