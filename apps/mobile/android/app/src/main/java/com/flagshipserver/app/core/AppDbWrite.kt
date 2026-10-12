package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.MessageDigest

/**
 * A signed order to change an app's live data (docs/app-apis.md §6). Reading
 * over the owner's paired session needs no signature (the box runs it READ
 * ONLY); a statement that may change data or schema carries this grant,
 * signed with the sensitive-order key:
 *
 *   flagship/app-db-write/v1|<serverDomain>|<serviceId>|<store>|<sha256 hex of the UTF-8 sql>|<issuedAt>
 *
 * Each order works once on the box, so a resend signs again with a new
 * issuedAt. packages/protocol/test-vectors/app-db-write/vectors.json is the
 * reference; AppDbWriteVectorsTest runs every case.
 */
object AppDbWrite {
    const val CANONICAL_TAG = "flagship/app-db-write/v1"

    /** Lowercase hex SHA-256 of the SQL's UTF-8 bytes, exactly as sent (no normalization). */
    fun sqlSha256(sql: String): String =
        HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(sql.toByteArray(Charsets.UTF_8)))

    data class Grant(
        val serverDomain: String,
        val serviceId: String,
        val store: String,
        val sqlSha256: String,
        val issuedAt: Long,
    )

    data class SignedGrant(val grant: Grant, val signatureHex: String)

    private val SHA256_HEX = Regex("^[0-9a-f]{64}$")

    fun canonicalBytes(g: Grant): ByteArray {
        require(g.serverDomain.isNotEmpty()) { "empty serverDomain" }
        require(g.serviceId.isNotEmpty()) { "empty serviceId" }
        require(g.store.isNotEmpty()) { "empty store" }
        for (f in listOf(g.serverDomain, g.serviceId, g.store)) {
            require(f.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "a field contains | or a control character" }
        }
        require(SHA256_HEX.matches(g.sqlSha256)) { "sqlSha256 must be 64 lowercase hex" }
        require(g.issuedAt >= 0) { "bad issuedAt" }
        return listOf(CANONICAL_TAG, g.serverDomain, g.serviceId, g.store, g.sqlSha256, g.issuedAt.toString())
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)
    }

    fun sign(key: Ed25519Sign, serverDomain: String, serviceId: String, store: String, sql: String, issuedAt: Long): SignedGrant {
        val g = Grant(serverDomain, serviceId, store, sqlSha256(sql), issuedAt)
        return SignedGrant(g, HexUtil.encode(key.sign(canonicalBytes(g))))
    }
}
