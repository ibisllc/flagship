// Server-migration order + control — the Kotlin mirrors of iOS
// `FlagshipCore/ServerMigrationOrders.swift` and the `server-migration`
// envelopes in `packages/protocol/src/serverMigration.ts`
// (docs/server-migration.md). Same owner, same `<server>.<user>` name, NEW
// hardware.
//
// The ORDER is the admin-signed "migrate this server" authorization (phase 1).
// SENSITIVE: it ultimately retires + wipes a box and re-homes routing, so it
// signs under the Slice-D admin master root (legacy owner-IRK when no admin
// root).
//
//  - oldStkPubHex binds the order to the CURRENT live instance, so a replayed
//    order can never re-migrate a later tenant of the same name.
//  - diskDisposition ∈ {"keep","wipe-after-handoff"} — a migration NEVER
//    authorizes `wipe-now` (invariant 1: the old box is wiped only after the
//    new box confirms take-over).
//
// Canonical bytes (byte-identical to TS + the Swift/webapp mirrors, pinned by
// `packages/protocol/tests/serverMigrationVectors.test.ts`):
//
//   flagship/server-migration/v1|<serverDomain lc>|<oldStkPubHex lc>|<diskDisposition>|<nonce lc>|<issuedAt>
//   flagship/server-migration-control/v1|<serverDomain lc>|<action>|<nonce lc>|<issuedAt>

package com.flagshipserver.app.core

object ServerMigrationOrder {
    const val CANONICAL_TAG = "flagship/server-migration/v1"

    fun canonicalBytes(
        serverDomain: String,
        oldStkPubHex: String,
        diskDisposition: String,
        nonce: String,
        issuedAt: Long,
    ): ByteArray =
        listOf(
            CANONICAL_TAG,
            serverDomain.lowercase(),
            oldStkPubHex.lowercase(),
            diskDisposition,
            nonce.lowercase(),
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
}

// The admin-signed phase-4/abort control (`confirm-ready` | `abort`) — same
// authority as the order; its own nonce so each control action is a distinct
// signature.
object ServerMigrationControl {
    const val CANONICAL_TAG = "flagship/server-migration-control/v1"

    fun canonicalBytes(
        serverDomain: String,
        action: String,
        nonce: String,
        issuedAt: Long,
    ): ByteArray =
        listOf(
            CANONICAL_TAG,
            serverDomain.lowercase(),
            action,
            nonce.lowercase(),
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
}
