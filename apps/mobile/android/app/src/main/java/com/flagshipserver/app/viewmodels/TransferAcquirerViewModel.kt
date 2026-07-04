// ACQUIRER side of transfer-a-box (docs/account-deletion-and-name-reclaim.md §4).
// Kotlin mirror of iOS FlagshipUI/ViewModels/TransferAcquirerViewModel.swift.
//
// From Home → Add a server → "Take over a transferred box", the camera scans the
// giver's QR. This VM parses it, then on confirm derives the acquirer IRK
// (biometric), signs a ServerTransferClaim binding the acquirer's username + IRK
// pub to the offer's nonce, and POSTs it — `.com` re-homes the box to the
// acquirer's namespace.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ServerTransferClient
import com.flagshipserver.app.core.ServerTransferFlow
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface TransferAcquirerPhase {
    data object Idle : TransferAcquirerPhase
    data class Scanned(val serverDomain: String) : TransferAcquirerPhase
    data object Signing : TransferAcquirerPhase
    data object Posting : TransferAcquirerPhase
    data class Claimed(val newServerDomain: String?) : TransferAcquirerPhase
    data class Failed(val message: String) : TransferAcquirerPhase
}

class TransferAcquirerViewModel(
    private val username: String,
    private val client: ServerTransferClient,
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val irkPubHex: suspend () -> String = { Keystore.irkPubHex() },
    /** Slice D — resolves the acquirer's ADMIN MASTER ROOT to sign the SENSITIVE
     *  CLAIM order, or null (legacy ⇒ IRK). The claim's `acquirerIrkPub` identity
     *  field stays the registered IRK; `.com` gates the signature on the admin
     *  root. */
    private val orderSigner: suspend (reason: String) -> Ed25519Sign? =
        { r -> if (Keystore.hasAdminRoot()) Keystore.adminRootKey(r) else null },
    /** §9.8 — this account's admin root pub, carried INSIDE the v2 claim
     *  canonical so the box re-pins it at re-home. Null ⇒ "" (unpin). */
    private val adminRootPubHex: suspend () -> String? = { Keystore.adminRootPubHex() },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val _phase = MutableStateFlow<TransferAcquirerPhase>(TransferAcquirerPhase.Idle)
    val phase: StateFlow<TransferAcquirerPhase> = _phase.asStateFlow()

    var offer: ServerTransferFlow.OfferQR? = null
        private set

    /** Reset to the scanner after a failure so the user can re-aim. */
    fun resetForRescan() {
        offer = null
        _phase.value = TransferAcquirerPhase.Idle
    }

    /** Validate a scanned/pasted transfer code. Accepts the URL form
     *  (`…/transfer?o=<b64url>`, `flagship://transfer?o=…`) OR a bare offer JSON.
     *
     *  SECURITY (Slice C): a scanned / deep-linked offer is attacker-supplied, so
     *  before we ever advance to a claimable state we Ed25519-VERIFY the offer
     *  signature against the embedded `giverIrkPub` over the canonical bytes AND
     *  reject an expired offer. An unverified / expired offer never becomes
     *  claimable (`confirm()` refuses when `offer` is null). Returns true only
     *  when the offer parses AND verifies AND is unexpired. */
    fun ingest(qrText: String): Boolean {
        val json = ServerTransferFlow.offerJsonFrom(qrText)
        if (json == null) {
            _phase.value = TransferAcquirerPhase.Failed("That isn't a Flagship transfer code.")
            return false
        }
        val parsed = try {
            ServerTransferFlow.parseQR(json)
        } catch (_: Throwable) {
            _phase.value = TransferAcquirerPhase.Failed("That isn't a Flagship transfer code.")
            return false
        }
        if (!ServerTransferFlow.verifyOfferSignature(parsed)) {
            _phase.value = TransferAcquirerPhase.Failed(
                "This transfer code didn't verify — its signature doesn't match the owner. Ask them for a fresh one.",
            )
            return false
        }
        if (parsed.expiresAt <= now()) {
            _phase.value = TransferAcquirerPhase.Failed(
                "This transfer code has expired. Ask the owner for a new one.",
            )
            return false
        }
        offer = parsed
        _phase.value = TransferAcquirerPhase.Scanned(parsed.serverDomain)
        return true
    }

    /** Sign + POST the claim (biometric). Advances to Claimed on success. */
    suspend fun confirm() {
        val parsed = offer
        if (parsed == null) {
            _phase.value = TransferAcquirerPhase.Failed("Scan a transfer code first.")
            return
        }
        _phase.value = TransferAcquirerPhase.Signing
        val key: Ed25519Sign
        val pub: String
        val orderKey: Ed25519Sign?
        try {
            key = signer("Take over ${parsed.serverDomain}")
            pub = irkPubHex()
            orderKey = orderSigner("Take over ${parsed.serverDomain}")
        } catch (e: Throwable) {
            _phase.value = TransferAcquirerPhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }
        try {
            val body = ServerTransferFlow.buildClaim(
                parsed, username, key, pub, now(), orderKey,
                acquirerAdminRootPubHex = adminRootPubHex() ?: "",
            )
            _phase.value = TransferAcquirerPhase.Posting
            val result = client.postClaim(parsed.serverDomain, body)
            _phase.value = TransferAcquirerPhase.Claimed(result.newServerDomain)
        } catch (e: ServerTransferFlow.TransferException) {
            _phase.value = if (e.message == "expired") {
                TransferAcquirerPhase.Failed("This transfer code has expired. Ask the owner for a new one.")
            } else {
                TransferAcquirerPhase.Failed("That transfer code is invalid.")
            }
        } catch (e: Throwable) {
            _phase.value = TransferAcquirerPhase.Failed("Couldn't claim the box: ${e.message}")
        }
    }
}
