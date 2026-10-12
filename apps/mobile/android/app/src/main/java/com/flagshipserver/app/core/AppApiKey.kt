package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.SecureRandom

/**
 * An app's API key grant (docs/app-apis.md §3). The phone picks the key id
 * and scope and signs them with the sensitive-order key; the box mints the
 * secret only for a grant the owner signed. Keys last until revoked, so the
 * app always sends expiresAt 0 (the field stays in the envelope):
 *
 *   flagship/app-api-key/v1|<serverDomain>|<serviceId>|<keyId>|<scope>|<expiresAt>|<issuedAt>
 *
 * packages/protocol/test-vectors/app-api-key/vectors.json is the reference;
 * AppApiKeyVectorsTest runs every case.
 */
object AppApiKey {
    const val CANONICAL_TAG = "flagship/app-api-key/v1"

    const val SCOPE_READ = "read"
    const val SCOPE_WRITE = "write"

    /** expiresAt for a key that never expires: what the app always sends. */
    const val NEVER = 0L

    private val KEY_ID = Regex("^[0-9a-f]{16}$")

    fun isValidKeyId(keyId: String): Boolean = KEY_ID.matches(keyId)

    /** 16 lowercase hex characters from 8 random bytes. */
    fun newKeyId(random: SecureRandom = SecureRandom()): String =
        HexUtil.encode(ByteArray(8).also { random.nextBytes(it) })

    fun canonicalBytes(
        serverDomain: String,
        serviceId: String,
        keyId: String,
        scope: String,
        expiresAt: Long,
        issuedAt: Long,
    ): ByteArray =
        listOf(CANONICAL_TAG, serverDomain, serviceId, keyId, scope, expiresAt.toString(), issuedAt.toString())
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)

    data class Grant(
        val serverDomain: String,
        val serviceId: String,
        val keyId: String,
        val scope: String,
        val expiresAt: Long,
        val issuedAt: Long,
    )

    data class SignedGrant(val grant: Grant, val signatureHex: String)

    fun sign(key: Ed25519Sign, grant: Grant): SignedGrant {
        require(isValidKeyId(grant.keyId)) { "keyId must be 16 lowercase hex" }
        require(grant.scope == SCOPE_READ || grant.scope == SCOPE_WRITE) { "scope must be read or write" }
        require(grant.expiresAt >= 0) { "expiresAt must be ms or 0" }
        val sig = key.sign(
            canonicalBytes(grant.serverDomain, grant.serviceId, grant.keyId, grant.scope, grant.expiresAt, grant.issuedAt),
        )
        return SignedGrant(grant, HexUtil.encode(sig))
    }
}
