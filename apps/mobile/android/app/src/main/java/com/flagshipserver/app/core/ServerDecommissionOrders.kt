// Server-decommission order — the Kotlin mirror of iOS
// `FlagshipCore/ServerDecommissionOrders.swift` and the `server-decommission`
// envelope in `packages/protocol/src/legacyEnvelopes.ts`
// (docs/server-replacement-graceful-decommission.md §6).
//
// Owner-IRK-signed "this box instance is replaced — retire yourself" order: a
// SELF-AUTHORIZING eviction notice. A box that receives it (by any channel) and
// verifies the signature + the STK-match runs the WHOLE closeout directly.
//
//  - retiredStkPubHex binds the order to ONE specific box instance (its STK
//    pubkey); the replacement box has a different STK and ignores it.
//  - diskDisposition ∈ {"keep","wipe-after-handoff","wipe-now"} (§6a).
//
// Canonical bytes (byte-identical to TS + the Swift mirror):
//
//   flagship/server-decommission/v1|<podCanonical>|<retiredStkPubHex>|<finalBackup as "1"|"0">|<diskDisposition>|<backupEpoch>|<nonce>|<issuedAt>
//
// podCanonical, retiredStkPubHex, and nonce are lowercased into the canonical
// bytes (matching the TS `.toLowerCase()`); diskDisposition is an enum literal
// carried verbatim. finalBackup encodes as the string "1" or "0"; backupEpoch
// and issuedAt are the plain decimal numbers (matching the TS `${number}`).

package com.flagshipserver.app.core

object ServerDecommissionOrder {
    const val CANONICAL_TAG = "flagship/server-decommission/v1"

    fun canonicalBytes(
        podCanonical: String,
        retiredStkPubHex: String,
        finalBackup: Boolean,
        diskDisposition: String,
        backupEpoch: Long,
        nonce: String,
        issuedAt: Long,
    ): ByteArray =
        listOf(
            CANONICAL_TAG,
            podCanonical.lowercase(),
            retiredStkPubHex.lowercase(),
            if (finalBackup) "1" else "0",
            diskDisposition,
            backupEpoch.toString(),
            nonce.lowercase(),
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
}
