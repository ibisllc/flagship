// Cloud recovery: wrap the UMK seed under a passkey-PRF-derived key,
// upload {credentialId, ciphertext, nonce} to flagshipserver.com.
// Mirrors apps/mobile/ios/Sources/Flagship/Recovery.swift +
// packages/server-daemon/src/recovery/prf.ts.
//
// The Android passkey-PRF ceremony goes through androidx.credentials
// CredentialManager (PublicKeyCredential + clientDataJSON with the
// `prf` extension). The wrap/unwrap math here is provider-agnostic
// so the same code paths work in tests with a synthetic PRF secret.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.HexUtil
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object Recovery {
    /** Fixed PRF input salt — `hmac-secret` is keyed by salt, so the
     *  daemon side, iOS, and Android must all agree. Mirrors the
     *  constant in packages/server-daemon/src/recovery/prf.ts. */
    val PRF_SALT: ByteArray = "flagship/recovery/v1".toByteArray()

    /** Wrap [umkSeed] (32 bytes) under a PRF-derived AES-256-GCM key.
     *  Returns the base64-url ciphertext + nonce ready to ship in a
     *  RecoveryEnvelopeRequest. */
    fun wrap(umkSeed: ByteArray, prfSecret: ByteArray): Sealed {
        val key = hkdfSha256(
            ikm = prfSecret,
            salt = "flagship/recovery-wrap/v1".toByteArray(),
            info = ByteArray(0),
            length = 32,
        )
        val nonce = ByteArray(12).also(rng::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ciphertext = cipher.doFinal(umkSeed)
        return Sealed(
            ciphertextBase64 = java.util.Base64.getEncoder().encodeToString(ciphertext),
            nonceBase64 = java.util.Base64.getEncoder().encodeToString(nonce),
        )
    }

    /** Reverse of [wrap]. Returns the recovered UMK seed bytes. */
    fun unwrap(ciphertextBase64: String, nonceBase64: String, prfSecret: ByteArray): ByteArray {
        val ct = java.util.Base64.getDecoder().decode(ciphertextBase64)
        val nonce = java.util.Base64.getDecoder().decode(nonceBase64)
        val key = hkdfSha256(
            ikm = prfSecret,
            salt = "flagship/recovery-wrap/v1".toByteArray(),
            info = ByteArray(0),
            length = 32,
        )
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return cipher.doFinal(ct)
    }

    data class Sealed(val ciphertextBase64: String, val nonceBase64: String)

    private val rng = SecureRandom()

    private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var counter = 1
        var written = 0
        while (written < length) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - written)
            System.arraycopy(t, 0, out, written, n)
            written += n
            counter++
        }
        return out
    }
}
