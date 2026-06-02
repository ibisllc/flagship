// #28 — the device-side of ACME account-key recovery.
//
// The ACME account key is the authority to mint a user's TLS certs. Unlike
// the IRK (which is HKDF-derived from the UMK), the account key is an
// independent admin-held ECDSA P-256 (ES256) key — Let's Encrypt account
// keys are ES256, NOT Ed25519. Losing every admin device would otherwise
// brick cert issuance forever, so the raw 32-byte scalar is ESCROWED
// (wrapped) into the SAME WebAuthn-PRF recovery envelope that carries the
// UMK, under its own HKDF salt for domain separation.
//
// CROSS-PLATFORM CONTRACT (must match iOS + the .com cloud byte-for-byte):
//   - private value      = 32-byte big-endian scalar S
//   - public encoding     = uncompressed SEC1: 0x04 ‖ X(32) ‖ Y(32) (65 bytes)
//   - accountKeyId        = lowercase sha256-hex of the uncompressed pubkey
//   - escrow wrap salt    = "flagship/recovery-acme-wrap/v1" (≠ the UMK's
//                           "flagship/recovery-wrap/v1" — domain separation)
//   - escrow blob          = base64(nonce(12) ‖ ciphertext ‖ gcmTag(16))
//
// The public point is derived with BouncyCastle's secp256r1 curve math so
// publicUncompressed(scalar) works for ANY scalar (incl. the scalar=2
// known-answer vector) independent of how the key was minted.

package com.flagshipserver.app.core

import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.jce.ECNamedCurveTable
import org.bouncycastle.jce.spec.ECNamedCurveParameterSpec

object AcmeAccountKey {
    /** HKDF salt for the escrow wrap. DIFFERENT from Recovery.wrap's UMK
     *  salt so the same PRF secret produces independent wrap keys. */
    val ESCROW_WRAP_SALT: ByteArray = "flagship/recovery-acme-wrap/v1".toByteArray()

    private const val CURVE = "secp256r1"
    private val spec: ECNamedCurveParameterSpec = ECNamedCurveTable.getParameterSpec(CURVE)
    private val rng = SecureRandom()

    /** Generate a fresh ECDSA P-256 private scalar (32 bytes, big-endian).
     *  Uses java.security keygen (StrongBox-independent — this key MUST be
     *  exportable for escrow) and reduces to the canonical 32-byte form. */
    fun generateScalar(): ByteArray {
        val gen = KeyPairGenerator.getInstance("EC")
        gen.initialize(ECGenParameterSpec(CURVE), rng)
        val priv = gen.generateKeyPair().private as ECPrivateKey
        return toFixed32(priv.s)
    }

    /** Uncompressed SEC1 public key (0x04 ‖ X ‖ Y, 65 bytes) for [scalar]·G
     *  on secp256r1. */
    fun publicUncompressed(scalar: ByteArray): ByteArray {
        val s = BigInteger(1, scalar)
        // `multiply` then `normalize` so getAffineX/Y are the affine
        // coordinates (BouncyCastle stores points projectively).
        val point = spec.g.multiply(s).normalize()
        val x = toFixed32(point.affineXCoord.toBigInteger())
        val y = toFixed32(point.affineYCoord.toBigInteger())
        val out = ByteArray(65)
        out[0] = 0x04
        System.arraycopy(x, 0, out, 1, 32)
        System.arraycopy(y, 0, out, 33, 32)
        return out
    }

    /** Lowercase sha256-hex of the uncompressed public key. The stable,
     *  cross-platform identifier for an account key. */
    fun accountKeyId(scalar: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(publicUncompressed(scalar))
        return HexUtil.encode(digest)
    }

    /** Wrap the raw 32-byte [scalar] under a PRF-derived AES-256-GCM key.
     *  Returns a single self-contained base64 blob = nonce(12) ‖ ct ‖
     *  tag(16) ready to ship as `wrappedAcmeAccountKey`. */
    fun wrapForEscrow(scalar: ByteArray, prfSecret: ByteArray): String {
        val key = hkdfSha256(ikm = prfSecret, salt = ESCROW_WRAP_SALT, info = ByteArray(0), length = 32)
        val nonce = ByteArray(12).also(rng::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ctWithTag = cipher.doFinal(scalar) // ciphertext ‖ 16-byte GCM tag
        val blob = ByteArray(nonce.size + ctWithTag.size)
        System.arraycopy(nonce, 0, blob, 0, nonce.size)
        System.arraycopy(ctWithTag, 0, blob, nonce.size, ctWithTag.size)
        return java.util.Base64.getEncoder().encodeToString(blob)
    }

    /** Reverse of [wrapForEscrow]: recover the 32-byte scalar. Throws
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

    /** Left-pad / strip a BigInteger to exactly 32 big-endian bytes.
     *  BigInteger.toByteArray() may add a leading 0x00 sign byte or emit
     *  fewer than 32 bytes; both are normalized here. */
    private fun toFixed32(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        val out = ByteArray(32)
        when {
            raw.size == 32 -> System.arraycopy(raw, 0, out, 0, 32)
            raw.size < 32 -> System.arraycopy(raw, 0, out, 32 - raw.size, raw.size)
            else -> System.arraycopy(raw, raw.size - 32, out, 0, 32) // drop leading sign byte(s)
        }
        return out
    }

    /** HKDF-SHA256. Identical construction to Recovery.hkdfSha256 +
     *  Keystore.hkdf — kept local so this object has no cross-package
     *  private dependency. */
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
