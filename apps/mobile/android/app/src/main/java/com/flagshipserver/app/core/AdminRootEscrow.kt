// Slice D (docs/device-admin-tier-spec.md §5.3, decision D-3) — escrow the
// ADMIN MASTER ROOT under the WebAuthn-PRF recovery credential.
//
// The admin master root is a fresh random Ed25519 seed, NOT UMK-derived, so a
// UMK backup alone can't reconstruct it. Losing every admin device would
// otherwise make admin authority unrecoverable. We therefore wrap the raw
// 32-byte seed into the SAME WebAuthn-PRF recovery envelope that carries the
// UMK + the ACME key, under its OWN HKDF salt for domain separation. Credential
// recovery unwraps it to re-establish admin (the rotation-proof SIGNING that
// re-pins boxes is a deferred follow-up — this only ensures the root survives).
//
// CROSS-PLATFORM CONTRACT (must match iOS + webapp byte-for-byte):
//   - private value     = 32-byte Ed25519 seed
//   - escrow wrap salt   = "flagship/recovery-admin-root-wrap/v1" (distinct from
//                          the UMK's "flagship/recovery-wrap/v1" and the ACME
//                          key's "flagship/recovery-acme-wrap/v1")
//   - escrow blob         = base64(nonce(12) ‖ ciphertext ‖ gcmTag(16))
//
// Wrapping construction is identical to AcmeAccountKey.wrapForEscrow (AES-256-
// GCM under an HKDF-SHA256-derived key); only the domain-separation salt differs.

package com.flagshipserver.app.core

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object AdminRootEscrow {
    /** HKDF salt for the admin-root escrow wrap — domain-separated from the UMK
     *  and ACME wraps so the same PRF secret produces an independent wrap key. */
    val ESCROW_WRAP_SALT: ByteArray = "flagship/recovery-admin-root-wrap/v1".toByteArray()

    private val rng = SecureRandom()

    /** Wrap the raw 32-byte admin-root [seed] under a PRF-derived AES-256-GCM
     *  key. Returns a self-contained base64 blob = nonce(12) ‖ ct ‖ tag(16)
     *  ready to ship as `wrappedAdminRoot`. */
    fun wrapForEscrow(seed: ByteArray, prfSecret: ByteArray): String {
        require(seed.size == 32) { "admin root seed must be 32 bytes" }
        val key = hkdfSha256(ikm = prfSecret, salt = ESCROW_WRAP_SALT, info = ByteArray(0), length = 32)
        val nonce = ByteArray(12).also(rng::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ctWithTag = cipher.doFinal(seed)
        val blob = ByteArray(nonce.size + ctWithTag.size)
        System.arraycopy(nonce, 0, blob, 0, nonce.size)
        System.arraycopy(ctWithTag, 0, blob, nonce.size, ctWithTag.size)
        return java.util.Base64.getEncoder().encodeToString(blob)
    }

    /** Reverse of [wrapForEscrow]: recover the 32-byte admin-root seed. Throws
     *  AEADBadTagException on a wrong PRF secret. */
    fun unwrapFromEscrow(base64Blob: String, prfSecret: ByteArray): ByteArray {
        val blob = java.util.Base64.getDecoder().decode(base64Blob)
        require(blob.size > 12) { "escrow blob too short" }
        val nonce = blob.copyOfRange(0, 12)
        val ctWithTag = blob.copyOfRange(12, blob.size)
        val key = hkdfSha256(ikm = prfSecret, salt = ESCROW_WRAP_SALT, info = ByteArray(0), length = 32)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return cipher.doFinal(ctWithTag)
    }

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
