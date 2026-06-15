// Kotlin mirror of the standalone JournalRequest envelope in
// packages/protocol/src/auth.ts (owner-IRK-signed journal read). The daemon's
// /api/journal re-derives these canonical bytes to verify the Ed25519
// signature against its config-pinned owner IRK, then allowlists `unit` and
// clamps `lines`. NOT a PhoneOrder (it mutates nothing) but the auth +
// 5-minute replay window match /api/power.
//
//   flagship/journal-read/v1|<serverId>|<unit>|<lines>|<issuedAt>
//
// MUST stay byte-identical to the TS + Swift encoders — pinned by
// JournalRequestTest here and JournalCanonicalTests on iOS.

package com.flagshipserver.app.core

/** Owner-IRK-signed journal-read canonical bytes. */
object JournalRequest {
    const val CANONICAL_TAG = "flagship/journal-read/v1"

    fun canonicalBytes(serverId: String, unit: String, lines: Long, issuedAt: Long): ByteArray = listOf(
        CANONICAL_TAG,
        serverId,
        unit,
        lines.toString(),
        issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)
}

/** Allowlisted units + defaults — mirror journalHttp.ts. */
object JournalUnits {
    val ALL = listOf("flagship-daemon", "flagship-data-services")
    const val DEFAULT_UNIT = "flagship-daemon"
    const val DEFAULT_LINES = 200L
    const val MAX_LINES = 500L
}
