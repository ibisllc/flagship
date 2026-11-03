// Kotlin mirror of the standalone JournalRequest envelope in
// packages/protocol/src/auth.ts (owner-IRK-signed journal read). The daemon's
// /api/journal re-derives these canonical bytes to verify the Ed25519
// signature against its config-pinned owner IRK, then allowlists `unit` and
// clamps `lines`. NOT a PhoneOrder (it mutates nothing). The box takes a
// request inside a 5-minute window and once per nonce (review 2026-10-25 #15).
//
//   flagship/journal-read/v2|<serverId>|<unit>|<lines>|<nonce>|<issuedAt>
//
// MUST stay byte-identical to the TS + Swift encoders — pinned by
// JournalRequestTest here and JournalCanonicalTests on iOS.

package com.flagshipserver.app.core

import java.security.SecureRandom

/** Owner-IRK-signed journal-read canonical bytes. */
object JournalRequest {
    const val CANONICAL_TAG = "flagship/journal-read/v2"
    private val NONCE = Regex("^[0-9a-f]{32}$")

    /** A single-use nonce: 16 bytes from SecureRandom as 32 lowercase hex. */
    fun newNonce(): String = ByteArray(16).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }

    fun canonicalBytes(serverId: String, unit: String, lines: Long, nonce: String, issuedAt: Long): ByteArray {
        require(NONCE.matches(nonce)) { "journal-read: nonce must be 32 lowercase hex" }
        return listOf(
            CANONICAL_TAG,
            serverId,
            unit,
            lines.toString(),
            nonce,
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }
}

/** Allowlisted units + defaults — mirror journalHttp.ts. */
object JournalUnits {
    val ALL = listOf("flagship-daemon", "flagship-data-services")
    const val DEFAULT_UNIT = "flagship-daemon"
    const val DEFAULT_LINES = 200L
    const val MAX_LINES = 500L
}
