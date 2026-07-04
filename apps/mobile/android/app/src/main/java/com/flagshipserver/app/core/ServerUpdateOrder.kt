// Admin-authorized in-place server-update order — the Kotlin mirror of iOS
// `FlagshipCore/ServerUpdateOrder.swift` and `packages/protocol/src/serverUpdate.ts`
// (docs/server-update-mechanism.md).
//
// The AUTHORIZATION half of the 2-of-2 update gate: an admin device signs this
// order naming ONE box + the exact target commit. The AUTHENTICITY half (the
// target commit is maintainer-ENDORSED) is enforced box-side by the daemon's
// ReleaseGate — neither half alone can push code.
//
// Canonical bytes (byte-identical to TS + the Swift mirror):
//
//   flagship/server-update/v1|<serverDomain>|<targetCommit>|<fromCommit>|<nonce>|<issuedAt>
//
// ALL string fields ride VERBATIM (no lowercasing — commits are matched exactly
// by the box), and each is guarded against `|` / control characters exactly
// like the TS `legacyFieldGuard`, so the canonical bytes can never be
// ambiguous. issuedAt is the plain decimal number (TS `String(issuedAt)`).

package com.flagshipserver.app.core

object ServerUpdateOrder {
    const val CANONICAL_TAG = "flagship/server-update/v1"

    /** Mirror of the TS `legacyFieldGuard`: reject `|` (0x7c) and control chars
     *  (0x00–0x1F, 0x7F) in any signed string field. */
    private fun guarded(name: String, value: String): String {
        for (ch in value) {
            val c = ch.code
            require(c != 0x7c && c > 0x1f && c != 0x7f) {
                "canonical-bytes field \"$name\" contains a reserved char"
            }
        }
        return value
    }

    fun canonicalBytes(
        serverDomain: String,
        targetCommit: String,
        fromCommit: String,
        nonce: String,
        issuedAt: Long,
    ): ByteArray =
        listOf(
            CANONICAL_TAG,
            guarded("serverDomain", serverDomain),
            guarded("targetCommit", targetCommit),
            guarded("fromCommit", fromCommit),
            guarded("nonce", nonce),
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
}
