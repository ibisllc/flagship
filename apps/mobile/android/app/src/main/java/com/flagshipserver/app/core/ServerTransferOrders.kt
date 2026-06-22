// Transfer-a-box orders — the Kotlin mirror of iOS
// `FlagshipCore/ServerTransferOrders.swift` and the `server-transfer-offer` +
// `server-transfer-claim` envelopes in `packages/protocol/src/legacyEnvelopes.ts`
// (docs/account-deletion-and-name-reclaim.md §4).
//
// Cross-account ownership handoff, two parties / two envelopes:
//  - server-transfer-offer: minted by the CURRENT owner's phone (giver IRK),
//    encoded into the QR on the box detail page. Does NOT name the acquirer.
//  - server-transfer-claim: minted by the ACQUIRER's phone (acquirer IRK) after
//    scanning, binding the acquirer's username + IRK pub to the offer's nonce.
//
// Canonical bytes (byte-identical to TS + the Swift mirror):
//
//   flagship/server-transfer-offer/v1|<serverDomain>|<transferNonce>|<issuedAt>|<expiresAt>
//   flagship/server-transfer-claim/v1|<serverDomain>|<transferNonce>|<acquirerUsername>|<acquirerIrkPubHex>|<issuedAt>
//
// serverDomain, transferNonce, and acquirerUsername are lowercased into the
// canonical bytes (matching the TS `.toLowerCase()`).

package com.flagshipserver.app.core

object ServerTransferOfferOrder {
    const val CANONICAL_TAG = "flagship/server-transfer-offer/v1"

    fun canonicalBytes(serverDomain: String, transferNonce: String, issuedAt: Long, expiresAt: Long): ByteArray =
        listOf(
            CANONICAL_TAG,
            serverDomain.lowercase(),
            transferNonce.lowercase(),
            issuedAt.toString(),
            expiresAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
}

object ServerTransferClaimOrder {
    const val CANONICAL_TAG = "flagship/server-transfer-claim/v1"

    fun canonicalBytes(
        serverDomain: String,
        transferNonce: String,
        acquirerUsername: String,
        acquirerIrkPubHex: String,
        issuedAt: Long,
    ): ByteArray =
        listOf(
            CANONICAL_TAG,
            serverDomain.lowercase(),
            transferNonce.lowercase(),
            acquirerUsername.lowercase(),
            acquirerIrkPubHex.lowercase(),
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
}
