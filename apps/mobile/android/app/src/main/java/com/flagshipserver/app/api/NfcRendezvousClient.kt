// C3 Wave 2 (Android) — cloud-rendezvous deposit client.
//
// Mirrors POST https://flagshipserver.com/api/nfc/rendezvous/:id/wifi
// from packages/control-plane/src/nfcRendezvous.ts.
//
// Body shape: { sealedHex, nonceHex } — both lowercase hex. The Worker
// rejects nonceHex != 24 chars (12-byte AEAD nonce) and caps sealedHex
// at 16384 hex chars (8 KB sealed-blob abuse cap). `sealedHex` is the
// protocol deposit blob: ePhonePub(32) || AEAD ciphertext (see
// `buildWifiDepositBlob` in core.NfcPair — the box needs the pub to
// derive K_session; tampering it in transit fails the AEAD open). The
// phone-side blob is well under 1 KB in practice.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.Serializable

interface NfcRendezvousClient {
    /** Deposit the deposit blob (hex) + AEAD nonce (hex) at the given
     *  rendezvous slot. Returns Result.failure when the Worker rejects
     *  the deposit. */
    suspend fun depositSealedWifi(rendezvousId: String, sealedHex: String, nonceHex: String): Result<Unit>
}

@Serializable
data class NfcRendezvousDepositRequest(
    val sealedHex: String,
    val nonceHex: String,
)

@Serializable
data class NfcRendezvousDepositResponse(
    val ok: Boolean,
    /** Wall-clock ms after which the deposited slot expires. */
    val expiresAt: Long,
)

// ── Live ──────────────────────────────────────────────────────────

class LiveNfcRendezvousClient(
    private val transport: JsonHttpTransport,
    baseUrl: String = DEFAULT_BASE_URL,
) : NfcRendezvousClient {
    private val base = baseUrl.trimEnd('/')

    companion object {
        const val DEFAULT_BASE_URL = "https://flagshipserver.com"
    }

    override suspend fun depositSealedWifi(
        rendezvousId: String,
        sealedHex: String,
        nonceHex: String,
    ): Result<Unit> {
        val encoded = java.net.URLEncoder.encode(rendezvousId, "UTF-8")
        val body = NfcRendezvousDepositRequest(
            sealedHex = sealedHex,
            nonceHex = nonceHex,
        )
        return try {
            transport.postJsonForResponse(
                url = "$base/api/nfc/rendezvous/$encoded/wifi",
                body = body,
                serializer = NfcRendezvousDepositRequest.serializer(),
                responseSerializer = NfcRendezvousDepositResponse.serializer(),
            )
            Result.success(Unit)
        } catch (t: Throwable) {
            Result.failure(t)
        }
    }
}

// ── Mock ──────────────────────────────────────────────────────────

/**
 * Test seam — records every deposit + lets callers script the next
 * outcome (e.g. simulate a 500 from the Worker). The captured deposit
 * round-trips through openWiFiConfig in the happy-path test.
 */
class MockNfcRendezvousClient(
    var nextOutcome: Result<Unit> = Result.success(Unit),
) : NfcRendezvousClient {
    data class Deposit(val rendezvousId: String, val sealedHex: String, val nonceHex: String)

    private val _deposits = mutableListOf<Deposit>()
    val deposits: List<Deposit> get() = _deposits

    override suspend fun depositSealedWifi(
        rendezvousId: String,
        sealedHex: String,
        nonceHex: String,
    ): Result<Unit> {
        _deposits += Deposit(rendezvousId, sealedHex, nonceHex)
        return nextOutcome
    }
}
