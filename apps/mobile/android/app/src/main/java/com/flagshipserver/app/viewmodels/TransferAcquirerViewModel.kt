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

    /** Validate a scanned/pasted QR string. Returns true when it parses. */
    fun ingest(qrText: String): Boolean {
        return try {
            val parsed = ServerTransferFlow.parseQR(qrText)
            offer = parsed
            _phase.value = TransferAcquirerPhase.Scanned(parsed.serverDomain)
            true
        } catch (_: Throwable) {
            _phase.value = TransferAcquirerPhase.Failed("That isn't a Flagship transfer code.")
            false
        }
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
        try {
            key = signer("Take over ${parsed.serverDomain}")
            pub = irkPubHex()
        } catch (e: Throwable) {
            _phase.value = TransferAcquirerPhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }
        try {
            val body = ServerTransferFlow.buildClaim(parsed, username, key, pub, now())
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
