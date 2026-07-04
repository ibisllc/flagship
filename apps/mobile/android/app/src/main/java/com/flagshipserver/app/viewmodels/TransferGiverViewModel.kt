// GIVER side of transfer-a-box (docs/account-deletion-and-name-reclaim.md §4).
// Kotlin mirror of iOS FlagshipUI/ViewModels/TransferGiverViewModel.swift.
//
// On the server-detail screen the owner taps "Transfer to another account",
// types the FQDN to confirm + passes the biometric; this VM:
//   1. derives the owner IRK (in `signer`) + reads its pub/seed,
//   2. builds + signs a one-time short-TTL offer + IRK mailbox-auth and deposits it,
//   3. exposes the QR text to render,
//   4. polls for the claim; on the claim it re-seals the disk key (Layer B):
//      unseal with the giver IRK, re-seal to the acquirer IRK, deposit — and,
//      when this device holds the admin master root, deposits the giver-signed
//      admin-root hand-off the box verifies before re-pinning (§9.8).
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
    /** Slice D — resolves the ADMIN MASTER ROOT to sign the SENSITIVE transfer
     *  OFFER + the §9.8 admin-root hand-off, or null (legacy ⇒ IRK offer, no
     *  hand-off). The mailbox AUTH + the disk-key re-seal (which needs the
     *  giver IRK) stay IRK. */
    private val orderSigner: suspend (reason: String) -> Ed25519Sign? =
        { r -> if (Keystore.hasAdminRoot()) Keystore.adminRootKey(r) else null },
    /** Admin-root pub hex — the QR `giverIrkPub` must TRACK the offer's signing
     *  key so the acquirer's local verify passes. Null ⇒ no admin root. */
    private val orderKeyPubHex: suspend () -> String? = { Keystore.adminRootPubHex() },
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
    /** The offer's nonce — the admin hand-off canonical binds to it. */
    private var transferNonce: String? = null

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
        // The offer ORDER signs with the admin master root when held; the QR's
        // giverIrkPub tracks it. The stored `irk`/`pubHex` above (used for the
        // later disk-key re-seal + poll auth) stay the membership IRK.
        val orderKey = orderSigner("Transfer $serverDomain to another account")
        val orderPub = if (orderKey != null) orderKeyPubHex() else null
        try {
            val built = ServerTransferFlow.buildOffer(
                serverDomain = serverDomain, username = username, irk = key, irkPubHex = pub,
                issuedAt = now(), orderKey = orderKey, orderKeyPubHex = orderPub,
            )
            transferNonce = built.body.offer.transferNonce
            _phase.value = TransferGiverPhase.Posting
            client.postOffer(serverDomain, built.body)
            // The QR is the universal-link form (`…/transfer?o=<b64url>`), NOT the
            // raw JSON — so any surface's camera / a browser open routes it
            // through the deep-link → acquirer path (Slice C). The acquirer VM
            // accepts both forms.
            qrText = ServerTransferFlow.offerUrl(built.qr)
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
        } catch (e: Throwable) {
            _phase.value = TransferGiverPhase.Failed(
                "Ownership moved, but the disk key re-seal failed: ${e.message}. The new owner can retry from their device.",
            )
            return true
        }
        // §9.8 — hand the acquirer's admin root to the box. The box only trusts
        // its PINNED anchor (the giver's admin root), so the GIVER signs the
        // hand-off; the biometric gate EMITS that signature (consent-as-crypto).
        // No admin root on this device ⇒ nothing pinned to hand off — skip.
        try {
            val nonce = transferNonce
            val giverAdminRoot = if (nonce != null) orderSigner("Hand off admin of $serverDomain") else null
            if (nonce != null && giverAdminRoot != null) {
                val oldPub = orderKeyPubHex() ?: error("admin root pub unavailable")
                val handoff = ServerTransferFlow.buildAdminHandoff(
                    serverDomain = serverDomain,
                    giverUsername = username,
                    acquirerUsername = poll.acquirerUsername ?: "",
                    oldAdminRootPubHex = oldPub,
                    newAdminRootPubHex = poll.acquirerAdminRootPub ?: "",
                    transferNonce = nonce,
                    issuedAt = now(),
                    giverAdminRoot = giverAdminRoot,
                )
                client.postAdminHandoff(serverDomain, handoff)
            }
            _phase.value = TransferGiverPhase.Completed(poll.newServerDomain)
            return true
        } catch (e: Throwable) {
            _phase.value = TransferGiverPhase.Failed(
                "Ownership moved, but the admin hand-off failed: ${e.message}. A box with a pinned admin root will wait for this hand-off before re-homing — retry from this device.",
            )
            return true
        }
    }
}
