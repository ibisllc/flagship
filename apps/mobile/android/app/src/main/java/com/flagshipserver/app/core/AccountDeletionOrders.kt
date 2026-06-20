// Account-deletion / username-reclaim orders — the Kotlin mirror of iOS
// `FlagshipCore/AccountDeletionOrders.swift` and the `account-self-delete` +
// `servers-self-delete` envelopes in `packages/protocol/src/legacyEnvelopes.ts`.
//
// Both are OWNER-IRK-signed and issued ONLY inside the last-device deletion
// ceremony (typed-username + biometric). `.com` verifies them against the
// username's registered IRK.
//
//  - account-self-delete: the last-device account-death order. `.com` enforces
//    "no other active device", then HARD-DELETES the username row (the name
//    frees immediately) + tears down every server the account owns.
//  - servers-self-delete: the opt-in "ask all my servers to delete their
//    content" order. NEVER standalone — `.com` accepts it ONLY when atomically
//    bundled with a valid account-self-delete (the bundle-ingest invariant;
//    docs/account-deletion-and-name-reclaim.md §5).
//
// The canonical bytes + `|`-joined field order MUST stay byte-identical to the
// TS generators and the Swift mirror:
//
//   flagship/account-self-delete/v1|<username>|<issuedAt>
//   flagship/servers-self-delete/v1|<username>|<issuedAt>
//
// `username` is lowercased into the canonical bytes (matching the TS
// `.toLowerCase()`).

package com.flagshipserver.app.core

object AccountSelfDeleteOrder {
    const val CANONICAL_TAG = "flagship/account-self-delete/v1"

    fun canonicalBytes(username: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, username.lowercase(), issuedAt.toString())
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)
}

object ServersSelfDeleteOrder {
    const val CANONICAL_TAG = "flagship/servers-self-delete/v1"

    fun canonicalBytes(username: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, username.lowercase(), issuedAt.toString())
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)
}
