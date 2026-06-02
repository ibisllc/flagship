// Cloud recovery: wrap the UMK seed under a passkey-PRF-derived key,
// upload a SINGLE self-contained `wrappedUmk` blob to flagshipserver.com.
// Mirrors apps/mobile/ios/Sources/Flagship/Recovery.swift +
// packages/server-daemon/src/recovery/prf.ts.
//
// The Worker's handleUploadWebauthnRecovery treats `wrappedUmk` as one
// opaque base64 blob — it base64-decodes it and hashes the whole thing.
// So the nonce lives INSIDE the blob (nonce ‖ ct ‖ tag), exactly like
// AcmeAccountKey.wrapForEscrow — there is NO separate nonce field on the
// wire.
//
// The Android passkey-PRF ceremony goes through androidx.credentials
// CredentialManager (PublicKeyCredential + clientDataJSON with the
// `prf` extension). The wrap/unwrap math here is provider-agnostic
// so the same code paths work in tests with a synthetic PRF secret.

package com.flagshipserver.app.keystore

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

    /** HKDF salt for the UMK wrap key. Domain-separated from the ACME
     *  escrow salt (AcmeAccountKey.ESCROW_WRAP_SALT) so the same PRF secret
     *  yields independent wrap keys. */
    val WRAP_SALT: ByteArray = "flagship/recovery-wrap/v1".toByteArray()

    /** Wrap [umkSeed] (32 bytes) under a PRF-derived AES-256-GCM key.
     *  Returns ONE self-contained base64 blob = nonce(12) ‖ ct ‖ tag(16),
     *  ready to ship verbatim as `wrappedUmk`. The nonce is inside the blob
     *  — there is no separate nonce field on the wire. */
    fun wrap(umkSeed: ByteArray, prfSecret: ByteArray): String {
        val key = hkdfSha256(ikm = prfSecret, salt = WRAP_SALT, info = ByteArray(0), length = 32)
        val nonce = ByteArray(12).also(rng::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ctWithTag = cipher.doFinal(umkSeed) // ciphertext ‖ 16-byte GCM tag
        val blob = ByteArray(nonce.size + ctWithTag.size)
        System.arraycopy(nonce, 0, blob, 0, nonce.size)
        System.arraycopy(ctWithTag, 0, blob, nonce.size, ctWithTag.size)
        return java.util.Base64.getEncoder().encodeToString(blob)
    }

    /** Reverse of [wrap]: take the single self-contained [wrappedUmkBase64]
     *  blob (nonce ‖ ct ‖ tag) and return the recovered UMK seed bytes.
     *  Throws AEADBadTagException on a wrong PRF secret. */
    fun unwrap(wrappedUmkBase64: String, prfSecret: ByteArray): ByteArray {
        val blob = java.util.Base64.getDecoder().decode(wrappedUmkBase64)
        require(blob.size > 12) { "wrapped UMK blob too short" }
        val nonce = blob.copyOfRange(0, 12)
        val ctWithTag = blob.copyOfRange(12, blob.size)
        val key = hkdfSha256(ikm = prfSecret, salt = WRAP_SALT, info = ByteArray(0), length = 32)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return cipher.doFinal(ctWithTag)
    }

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
