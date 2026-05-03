package com.flagship.keystore

import com.google.crypto.tink.signature.Ed25519PrivateKeyManager
import com.google.crypto.tink.subtle.Ed25519Sign

/**
 * Mirrors @flagship/protocol's auth canonicalization. Keep in sync with
 * `packages/protocol/src/auth.ts`.
 */
data class BootChallenge(
    val serverId: String,
    val nonce: ByteArray,
    val issuedAt: Long
)

object BootAuthorization {
    fun sign(challenge: BootChallenge, bakSeed: ByteArray): ByteArray {
        val signer = Ed25519Sign(bakSeed)
        return signer.sign(canonicalBytes(challenge))
    }

    private fun canonicalBytes(c: BootChallenge): ByteArray {
        val s = "flagship/boot/v1|${c.serverId}|${c.nonce.toHex()}|${c.issuedAt}"
        return s.toByteArray(Charsets.UTF_8)
    }

    private fun ByteArray.toHex(): String =
        joinToString("") { "%02x".format(it) }
}
