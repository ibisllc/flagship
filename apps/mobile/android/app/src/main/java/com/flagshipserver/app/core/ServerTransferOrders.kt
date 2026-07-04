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
//   flagship/server-transfer-claim/v2|<serverDomain>|<transferNonce>|<acquirerUsername>|<acquirerIrkPubHex>|<acquirerAdminRootPubHex>|<issuedAt>
//
// serverDomain, transferNonce, acquirerUsername, and the pub hexes are
// lowercased into the canonical bytes (matching the TS `.toLowerCase()`).
//
// Claim v2 (device-admin-tier spec §9.8): the acquirer's ADMIN MASTER ROOT pub
// rides INSIDE the signed canonical (empty string when the acquirer account has
// none) so the box can re-pin the acquirer's authority anchor at re-home — a
// value `.com` merely relayed outside the signature could be swapped.

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
    const val CANONICAL_TAG = "flagship/server-transfer-claim/v2"

    fun canonicalBytes(
        serverDomain: String,
        transferNonce: String,
        acquirerUsername: String,
        acquirerIrkPubHex: String,
        acquirerAdminRootPubHex: String,
        issuedAt: Long,
    ): ByteArray =
        listOf(
            CANONICAL_TAG,
            serverDomain.lowercase(),
            transferNonce.lowercase(),
            acquirerUsername.lowercase(),
            acquirerIrkPubHex.lowercase(),
            acquirerAdminRootPubHex.lowercase(),
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
}
