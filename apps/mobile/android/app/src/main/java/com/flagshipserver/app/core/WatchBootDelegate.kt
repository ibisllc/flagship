package com.flagshipserver.app.core

import java.security.MessageDigest

/**
 * `flagship/watch-boot-delegate/v1`: the account key's attestation of a copy of one server's disk key
 * sealed to a watch's boot-only X25519 key. Wire parity with packages/protocol/src/watchBootDelegate.ts and
 * FlagshipCore/WatchBootDelegate.swift; pinned by test-vectors/watch-boot-delegate/vectors.json.
 *
 *   flagship/watch-boot-delegate/v1|<serverDomain lowercase>|<delegatePubHex>|<decryptPubHex>|<keySha256Hex>|<issuedAt>|<expiresAt>
 */
object WatchBootDelegate {
    const val CANONICAL_TAG = "flagship/watch-boot-delegate/v1"
    const val MAX_MS = 7L * 24 * 3_600_000

    private val hex64 = Regex("^[0-9a-f]{64}$")

    data class Attestation(
        val serverDomain: String,
        val delegatePubHex: String,
        val decryptPubHex: String,
        val keySha256Hex: String,
        val issuedAt: Long,
        val expiresAt: Long,
    )

    class Deposit(val attestation: Attestation, val sealedKeyHex: String, val signatureHex: String)

    fun canonicalBytes(a: Attestation): ByteArray {
        require(a.serverDomain.isNotEmpty() && a.serverDomain.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "serverDomain" }
        require(hex64.matches(a.delegatePubHex)) { "delegatePubHex" }
        require(hex64.matches(a.decryptPubHex)) { "decryptPubHex" }
        require(hex64.matches(a.keySha256Hex)) { "keySha256Hex" }
        require(a.issuedAt >= 0) { "issuedAt" }
        require(a.expiresAt > a.issuedAt) { "expiresAt" }
        require(a.expiresAt - a.issuedAt <= MAX_MS) { "a watch boot key lasts at most 7 days" }
        return listOf(
            CANONICAL_TAG, a.serverDomain.lowercase(), a.delegatePubHex, a.decryptPubHex,
            a.keySha256Hex, a.issuedAt.toString(), a.expiresAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Admin device: seal the unsealed disk key for the watch's decryption key and sign the attestation. */
    fun build(
        serverDomain: String,
        diskKey: ByteArray,
        delegatePub: ByteArray,
        decryptPub: ByteArray,
        issuedAt: Long,
        expiresAt: Long,
        sign: (ByteArray) -> ByteArray,
    ): Deposit {
        val a = Attestation(
            serverDomain.lowercase(), delegatePub.toHex(), decryptPub.toHex(),
            sha256(diskKey).toHex(), issuedAt, expiresAt,
        )
        val sig = sign(canonicalBytes(a))
        return Deposit(a, SecretSeal.sealForRecipient(diskKey, decryptPub).toHex(), sig.toHex())
    }

    /** Watch: open the copy with the boot-only decryption key; null unless it is the key the account attested. */
    fun openKey(d: Deposit, decryptPriv: ByteArray): ByteArray? {
        val sealed = fromHex(d.sealedKeyHex) ?: return null
        val key = try {
            SecretSeal.openWithX25519(sealed, decryptPriv)
        } catch (_: Exception) {
            return null
        }
        return if (sha256(key).toHex() == d.attestation.keySha256Hex.lowercase()) key else null
    }

    private fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)
    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
    private fun fromHex(h: String): ByteArray? {
        if (h.length % 2 != 0 || !h.all { it in '0'..'9' || it in 'a'..'f' }) return null
        return ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
