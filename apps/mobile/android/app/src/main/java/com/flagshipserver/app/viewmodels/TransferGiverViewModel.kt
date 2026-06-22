// GIVER side of transfer-a-box (docs/account-deletion-and-name-reclaim.md §4).
// Kotlin mirror of iOS FlagshipUI/ViewModels/TransferGiverViewModel.swift.
//
// On the server-detail screen the owner taps "Transfer to another account",
// types the FQDN to confirm + passes the biometric; this VM:
//   1. derives the owner IRK (in `signer`) + reads its pub/seed,
//   2. builds + signs a one-time short-TTL offer + IRK mailbox-auth and deposits it,
//   3. exposes the QR text to render,
//   4. polls for the claim; on the claim it re-seals the disk key (Layer B):
//      unseal with the giver IRK, re-seal to the acquirer IRK, deposit.
//
// The biometric fires ONCE (in `signer`); the derived IRK + seed are reused for
// the re-seal so there's no second prompt.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.ServerTransferClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerTransferFlow
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface TransferGiverPhase {
    data object Idle : TransferGiverPhase
    data object Signing : TransferGiverPhase
    data object Posting : TransferGiverPhase
    /** Offer deposited; [TransferGiverViewModel.qrText] is set. Polling. */
    data object AwaitingClaim : TransferGiverPhase
    data object Resealing : TransferGiverPhase
    data class Completed(val newServerDomain: String?) : TransferGiverPhase
    data class Failed(val message: String) : TransferGiverPhase
}

class TransferGiverViewModel(
    private val serverDomain: String,
    private val username: String,
    private val client: ServerTransferClient,
    private val mailbox: SecretMailboxClient,
    /** Biometric-gated owner-IRK signer. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    /** The IRK pub hex (after the biometric). */
    private val irkPubHex: suspend () -> String = { Keystore.irkPubHex() },
    /** The IRK seed (after deriveIRK) — needed to unseal the box's disk key. */
    private val irkSeed: () -> ByteArray = { Keystore.requireIrkSeedForVersion(Keystore.currentIrkVersion()) },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val _phase = MutableStateFlow<TransferGiverPhase>(TransferGiverPhase.Idle)
    val phase: StateFlow<TransferGiverPhase> = _phase.asStateFlow()

    var qrText: String? = null
        private set

    private var irk: Ed25519Sign? = null
    private var pubHex: String? = null

    /** Build + deposit the offer (biometric). Advances to AwaitingClaim with
     *  [qrText] set on success. */
    suspend fun start() {
        _phase.value = TransferGiverPhase.Signing
        val key: Ed25519Sign
        val pub: String
        try {
            key = signer("Transfer $serverDomain to another account")
            pub = irkPubHex()
        } catch (e: Throwable) {
            _phase.value = TransferGiverPhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }
        irk = key
        pubHex = pub
        try {
            val built = ServerTransferFlow.buildOffer(
                serverDomain = serverDomain, username = username, irk = key, irkPubHex = pub, issuedAt = now(),
            )
            _phase.value = TransferGiverPhase.Posting
            client.postOffer(serverDomain, built.body)
            qrText = ServerTransferFlow.encodeQR(built.qr)
            _phase.value = TransferGiverPhase.AwaitingClaim
        } catch (e: Throwable) {
            _phase.value = TransferGiverPhase.Failed("Couldn't reach the broker: ${e.message}")
        }
    }

    /** One claim poll. On a claim, re-seal the disk key + finish. Returns true
     *  once the transfer is complete (the caller can stop polling). */
    suspend fun pollOnce(): Boolean {
        val key = irk ?: return false
        val pub = pubHex ?: return false
        if (_phase.value != TransferGiverPhase.AwaitingClaim) return false
        val poll = try {
            client.pollClaim(serverDomain, ServerTransferFlow.buildMailboxAuth(username, key, pub, now()))
        } catch (_: Throwable) {
            return false // transient — keep polling
        }
        val acquirerIrk = poll?.acquirerIrkPub ?: return false

        _phase.value = TransferGiverPhase.Resealing
        try {
            // Unseal the box's disk key (sealed FOR the giver IRK at install) and
            // re-seal to the acquirer IRK. A box with no LUKS key has nothing to
            // hand off — skip to completion.
            val sealed = runCatching { mailbox.fetchSealedLuksKey(serverDomain) }.getOrNull()
            if (sealed != null && sealed.sealedKey.isNotEmpty()) {
                val diskKey = ServerTransferFlow.openGiverDiskKey(sealed.sealedKey, irkSeed())
                val deposit = ServerTransferFlow.buildDiskKeyDeposit(
                    serverDomain = serverDomain, username = username, irk = key, irkPubHex = pub,
                    diskKey = diskKey, acquirerIrkPubHex = acquirerIrk, issuedAt = now(),
                )
                client.postDiskKey(serverDomain, deposit)
            }
            _phase.value = TransferGiverPhase.Completed(poll.newServerDomain)
            return true
        } catch (e: Throwable) {
            _phase.value = TransferGiverPhase.Failed(
                "Ownership moved, but the disk key re-seal failed: ${e.message}. The new owner can retry from their device.",
            )
            return true
        }
    }
}
