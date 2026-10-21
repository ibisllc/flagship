package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.util.Base64

/**
 * Owner debug access (Kotlin mirror of packages/protocol/src/debugAccess.ts;
 * docs/recipe-delivery-and-remote-install.md "Debug access"): one SSH public
 * key the box lets in as `debug` until a set time, signed by the account's
 * admin root. Vectors: packages/protocol/test-vectors/debug-access/.
 *
 *   flagship/debug-access/v2|<serverDomain>|<sshPublicKey>|<issuedAt>|<expiresAt>
 *   flagship/debug-access-revoke/v1|<serverDomain>|<issuedAt>
 */
object DebugAccess {
    const val TAG = "flagship/debug-access/v2"
    const val REVOKE_TAG = "flagship/debug-access-revoke/v1"
    const val HOUR_MS = 60L * 60 * 1000
    const val DEFAULT_MS = 24 * HOUR_MS
    const val MAX_MS = 7 * 24 * HOUR_MS

    val WARNING get() = FSStrings.get(R.string.anyone_with_this_key_can_read)
    val CREATE_WARNING get() = FSStrings.get(R.string.it_turns_off_by_itself_7, WARNING)
    val ADMIN_ONLY get() = FSStrings.get(R.string.only_an_admin_device_can_turn)

    /** The lengths the apps offer; 24 hours is the default. */
    enum class Duration(val ms: Long, val label: String) {
        HOUR(HOUR_MS, "1 hour"),
        DAY(DEFAULT_MS, "24 hours"),
        WEEK(MAX_MS, "7 days"),
    }

    val KEY_TYPES = listOf(
        "ssh-ed25519",
        "sk-ssh-ed25519@openssh.com",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "sk-ecdsa-sha2-nistp256@openssh.com",
        "ssh-rsa",
    )

    data class Grant(val serverDomain: String, val sshPublicKey: String, val issuedAt: Long, val expiresAt: Long)
    data class Revoke(val serverDomain: String, val issuedAt: Long)

    private val B64 = Regex("^[A-Za-z0-9+/]+={0,2}$")

    private fun b64decode(s: String): ByteArray? {
        if (!B64.matches(s) || s.length % 4 != 0) return null
        return try { Base64.getDecoder().decode(s) } catch (_: IllegalArgumentException) { null }
    }

    /**
     * A pasted OpenSSH public key line as `<type> <base64>` (options and comment
     * dropped), or null when it isn't one: the blob must decode and name the
     * same type inside.
     */
    fun normalizeSshPublicKey(input: String): String? {
        val parts = input.trim().split(Regex("\\s+"))
        val at = parts.indexOfFirst { it in KEY_TYPES }
        if (at < 0 || at + 1 >= parts.size) return null
        val type = parts[at]
        val body = parts[at + 1]
        val blob = b64decode(body) ?: return null
        if (blob.size < 4 + type.length || blob.size > 4096) return null
        val n = ((blob[0].toInt() and 0xff) shl 24) or ((blob[1].toInt() and 0xff) shl 16) or
            ((blob[2].toInt() and 0xff) shl 8) or (blob[3].toInt() and 0xff)
        if (n != type.length) return null
        if (String(blob, 4, n, Charsets.UTF_8) != type) return null
        return "$type $body"
    }

    /** OpenSSH's `SHA256:<base64 without padding>` fingerprint, or null. */
    fun fingerprint(key: String): String? {
        val norm = normalizeSshPublicKey(key) ?: return null
        val blob = Base64.getDecoder().decode(norm.substringAfter(' '))
        val digest = MessageDigest.getInstance("SHA-256").digest(blob)
        return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
    }

    /** Why a grant can't be signed, as the sentence to show; null when it can. */
    fun grantProblem(g: Grant): String? = when {
        g.serverDomain.isEmpty() -> FSStrings.get(R.string.the_debug_access_grant_doesnt_name)
        g.sshPublicKey.isBlank() -> FSStrings.get(R.string.debug_access_needs_an_ssh_public)
        normalizeSshPublicKey(g.sshPublicKey) != g.sshPublicKey -> FSStrings.get(R.string.that_isnt_an_ssh_public_key)
        g.issuedAt <= 0 -> FSStrings.get(R.string.the_debug_access_grant_has_no)
        g.expiresAt <= g.issuedAt -> FSStrings.get(R.string.debug_access_has_to_end_after)
        g.expiresAt - g.issuedAt > MAX_MS -> FSStrings.get(R.string.debug_access_can_be_on_for)
        else -> null
    }

    private fun guard(name: String, v: String) {
        require(v.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "$name can't hold '|' or control characters" }
    }

    fun canonicalBytes(g: Grant): ByteArray {
        guard("serverDomain", g.serverDomain)
        guard("sshPublicKey", g.sshPublicKey)
        return "$TAG|${g.serverDomain}|${g.sshPublicKey}|${g.issuedAt}|${g.expiresAt}".toByteArray(Charsets.UTF_8)
    }

    fun revokeCanonicalBytes(r: Revoke): ByteArray {
        guard("serverDomain", r.serverDomain)
        return "$REVOKE_TAG|${r.serverDomain}|${r.issuedAt}".toByteArray(Charsets.UTF_8)
    }

    /** Sign with the admin root (the IRK only on a box with none pinned). Throws the problem sentence. */
    fun sign(g: Grant, key: Ed25519Sign): String {
        grantProblem(g)?.let { throw IllegalArgumentException(it) }
        return HexUtil.encode(key.sign(canonicalBytes(g)))
    }

    fun signRevoke(r: Revoke, key: Ed25519Sign): String = HexUtil.encode(key.sign(revokeCanonicalBytes(r)))

    fun verify(g: Grant, signatureHex: String, pub: ByteArray): Boolean {
        if (grantProblem(g) != null) return false
        return verifyBytes(canonicalBytes(g), signatureHex, pub)
    }

    fun verifyRevoke(r: Revoke, signatureHex: String, pub: ByteArray): Boolean =
        r.serverDomain.isNotEmpty() && verifyBytes(revokeCanonicalBytes(r), signatureHex, pub)

    private fun verifyBytes(bytes: ByteArray, signatureHex: String, pub: ByteArray): Boolean {
        val sig = HexUtil.decode(signatureHex) ?: return false
        return try {
            Ed25519Verify(pub).verify(sig, bytes)
            true
        } catch (_: Throwable) {
            false
        }
    }

    fun grantJson(g: Grant): JsonObject = buildJsonObject {
        put("serverDomain", g.serverDomain)
        put("sshPublicKey", g.sshPublicKey)
        put("issuedAt", g.issuedAt)
        put("expiresAt", g.expiresAt)
    }

    /** `{grant, signatureHex}`: the recipe's `debugGrant` sibling and the body of POST /api/screens/debug-access. */
    fun envelopeJson(g: Grant, signatureHex: String): String = buildJsonObject {
        put("grant", grantJson(g))
        put("signatureHex", signatureHex)
    }.toString()

    /** `{revoke, signatureHex}`: the body of POST /api/screens/debug-access/revoke. */
    fun revokeJson(r: Revoke, signatureHex: String): String = buildJsonObject {
        put("revoke", buildJsonObject {
            put("serverDomain", r.serverDomain)
            put("issuedAt", r.issuedAt)
        })
        put("signatureHex", signatureHex)
    }.toString()
}
