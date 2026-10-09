// Name dibs — claim the account name matching a .com you control
// (docs/naming-recovery-and-name-change.md §7). Canonical bytes mirror
// packages/protocol/src/nameDibs.ts byte-for-byte; pinned by the shared
// vectors in CanonicalBytesVectorsTest.

package com.flagshipserver.app.core

object NameDibsInitiate {
    const val CANONICAL_TAG = "flagship/name-dibs-initiate/v1"
    fun canonicalBytes(username: String, name: String, irkPubHex: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, username, name, irkPubHex, issuedAt.toString()).joinToString("|").toByteArray()
}

object NameDibsVerify {
    const val CANONICAL_TAG = "flagship/name-dibs-verify/v1"
    fun canonicalBytes(username: String, name: String, nonce: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, username, name, nonce, issuedAt.toString()).joinToString("|").toByteArray()
}

/** The paid name change — bound to the account's stable AID so a captured
 *  envelope can't be replayed against another account. */
object NameChangeEnvelope {
    const val CANONICAL_TAG = "flagship/name-change/v1"
    fun canonicalBytes(aidPubHex: String, oldUsername: String, newUsername: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, aidPubHex, oldUsername, newUsername, issuedAt.toString()).joinToString("|").toByteArray()
}
