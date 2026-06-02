// #28 — the mint POST for an AcmeAccountKeyGrant (SEAL-TO-BOX). Kept OUT of
// FlagshipServerClient.kt (another worker edits that file) as an extension on
// LiveFlagshipServerClient.
//
// Wire shape mirrors packages/control-plane/src/acmeAccountKeys.ts
// `handleMintAcmeAccountKeyGrant`:
//   POST /api/users/:u/acme-account-keys
//   body { grant: { grantId, username, accountKeyId, recipientPubKey(32B hex),
//                   sealedAccountKey(hex), issuedAt(ms), expiresAt(ms) },
//          signature(64B hex, Ed25519 IRK over the canonical grant) }
//   reply { ok, grantId, username, accountKeyId, recipientPubKey, expiresAt }
//          — the sealed key is DELIBERATELY absent from the reply.
//
// recipientPubKey + sealedAccountKey are sent as LOWERCASE hex (HexUtil.encode),
// matching the canonical bytes the IRK signed over.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.ProducedAcmeAccountKeyGrant
import kotlinx.serialization.Serializable

/** Request body for POST /api/users/:u/acme-account-keys. */
@Serializable
data class AcmeAccountKeyGrantMintRequest(
    val grant: Grant,
    val signature: String, // hex, Ed25519 IRK
) {
    @Serializable
    data class Grant(
        val grantId: String,
        val username: String,
        val accountKeyId: String,
        val recipientPubKey: String,   // 32-byte hex
        val sealedAccountKey: String,  // opaque ciphertext, hex
        val issuedAt: Long,
        val expiresAt: Long,
    )

    companion object {
        /** Build the wire request from a produced grant — hex-encodes the raw
         *  byte fields (lowercase) so they match the signed canonical bytes. */
        fun from(p: ProducedAcmeAccountKeyGrant): AcmeAccountKeyGrantMintRequest =
            AcmeAccountKeyGrantMintRequest(
                grant = Grant(
                    grantId = p.grantId,
                    username = p.username,
                    accountKeyId = p.accountKeyId,
                    recipientPubKey = HexUtil.encode(p.recipientPubKey),
                    sealedAccountKey = HexUtil.encode(p.sealedAccountKey),
                    issuedAt = p.issuedAt,
                    expiresAt = p.expiresAt,
                ),
                signature = p.signatureHex,
            )
    }
}

/** Public-fields-only mint reply. The sealed key is never echoed. */
@Serializable
data class AcmeAccountKeyGrantMintResponse(
    val ok: Boolean = true,
    val grantId: String,
    val username: String,
    val accountKeyId: String,
    val recipientPubKey: String,
    val expiresAt: Long,
)

/**
 * POST a SEAL-TO-BOX grant. The username path segment is URL-encoded; the body
 * also carries username (the handler normalizes / matches both). Returns the
 * public-reference reply.
 *
 * Declared as an extension on [FlagshipServerClient] per the #28 handoff while
 * deliberately NOT editing FlagshipServerClient.kt (another worker owns it).
 * `LiveFlagshipServerClient`'s `transport` + `base` are private, so the call
 * takes the [transport] + [baseUrl] explicitly — the same two handles the
 * caller already used to build the client.
 */
suspend fun FlagshipServerClient.mintAcmeAccountKeyGrant(
    transport: JsonHttpTransport,
    username: String,
    request: AcmeAccountKeyGrantMintRequest,
    baseUrl: String = LiveFlagshipServerClient.DEFAULT_BASE_URL,
): AcmeAccountKeyGrantMintResponse {
    val base = baseUrl.trimEnd('/')
    val encoded = java.net.URLEncoder.encode(username, "UTF-8")
    return transport.postJsonForResponse(
        "$base/api/users/$encoded/acme-account-keys",
        request,
        serializer = AcmeAccountKeyGrantMintRequest.serializer(),
        responseSerializer = AcmeAccountKeyGrantMintResponse.serializer(),
    )
}
