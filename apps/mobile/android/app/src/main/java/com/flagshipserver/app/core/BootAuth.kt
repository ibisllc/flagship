// Builds the `Authorization` header for the dedicated boot worker
// (boot.flagshipserver.com). Kotlin mirror of FlagshipCore/BootAuth.swift +
// apps/boot/src/gate.ts. The phone is the OWNER principal (writes — deposit a
// lease, revoke a lease, post a sealed response), signing with the account IRK.
//
//   Authorization: Flagship-Boot-v1 <base64url(JSON of the envelope)>
//
// The Ed25519 signature covers the canonical bytes
//   flagship/boot-auth/v1|<role>|<serverDomain>|<METHOD>|<path>|<pubKeyHex>|<nonceHex>|<issuedAt>
// so a captured header can't be retargeted. The boot worker re-derives these
// by field name (JSON key order is irrelevant) and verifies the signature
// against the directory-bound account IRK.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

object BootAuth {
    const val SCHEME = "Flagship-Boot-v1"
    const val CANONICAL_TAG = "flagship/boot-auth/v1"

    /** Canonical bytes the signature covers. MUST match gate.ts
     *  canonicalBootAuth exactly. */
    fun canonicalBytes(
        role: String,
        serverDomain: String,
        method: String,
        path: String,
        pubKeyHex: String,
        nonceHex: String,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        role,
        serverDomain,
        method.uppercase(),
        path,
        pubKeyHex.lowercase(),
        nonceHex.lowercase(),
        issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    @Serializable
    private data class Envelope(
        val role: String,
        val serverDomain: String,
        val method: String,
        val path: String,
        val pubKeyHex: String,
        val nonceHex: String,
        val issuedAt: Long,
        val signatureHex: String,
    )

    private val json = Json { encodeDefaults = true }

    /** Build the owner-role `Authorization` header value, IRK-signed.
     *  `method` is uppercased; `path` is the exact request path (no query),
     *  including any domain/leaseId segment — it must equal what the worker
     *  router resolves. */
    fun ownerHeader(
        serverDomain: String,
        method: String,
        path: String,
        signer: Ed25519Sign,
        pubHex: String,
        issuedAt: Long,
        nonce: ByteArray,
    ): String {
        val nonceHex = HexUtil.encode(nonce)
        val canon = canonicalBytes("owner", serverDomain, method, path, pubHex, nonceHex, issuedAt)
        val sig = signer.sign(canon)
        val env = Envelope(
            role = "owner",
            serverDomain = serverDomain,
            method = method.uppercase(),
            path = path,
            pubKeyHex = pubHex,
            nonceHex = nonceHex,
            issuedAt = issuedAt,
            signatureHex = HexUtil.encode(sig),
        )
        val jsonStr = json.encodeToString(Envelope.serializer(), env)
        return "$SCHEME ${base64url(jsonStr.toByteArray(Charsets.UTF_8))}"
    }

    /** Build the delegate-role `Authorization` header, signed by the
     *  watch-delegate key (NOT the IRK). The boot worker accepts this ONLY on
     *  POST /api/boot/response (the per-boot approval); every other route is
     *  owner-IRK only. Byte-identical to ownerHeader except role="delegate". */
    fun delegateHeader(
        serverDomain: String,
        method: String,
        path: String,
        signer: Ed25519Sign,
        pubHex: String,
        issuedAt: Long,
        nonce: ByteArray,
    ): String {
        val nonceHex = HexUtil.encode(nonce)
        val canon = canonicalBytes("delegate", serverDomain, method, path, pubHex, nonceHex, issuedAt)
        val sig = signer.sign(canon)
        val env = Envelope(
            role = "delegate",
            serverDomain = serverDomain,
            method = method.uppercase(),
            path = path,
            pubKeyHex = pubHex,
            nonceHex = nonceHex,
            issuedAt = issuedAt,
            signatureHex = HexUtil.encode(sig),
        )
        val jsonStr = json.encodeToString(Envelope.serializer(), env)
        return "$SCHEME ${base64url(jsonStr.toByteArray(Charsets.UTF_8))}"
    }

    /** base64url without padding — matches gate.ts b64urlDecode (re-pads). */
    private fun base64url(b: ByteArray): String =
        java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b)
}
