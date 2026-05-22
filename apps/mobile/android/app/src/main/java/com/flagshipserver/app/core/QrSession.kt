// Phone-side QR-relay session: X25519 ECDH with the browser, HKDF →
// (kEnc, matchCode), AES-256-GCM seal of the install-blob bundle.
//
// MIRRORS:
//   - apps/web/public/heroQr.js (browser side)
//   - apps/web/public/webapp/views/create-server.js `deliverThroughRelay`
//
// All bytes are derived locally — the relay never sees plaintext.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.X25519
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Cryptographic envelope for a single phone↔browser QR pairing.
 * Construct once, call [pair] with the browser's pubkey to derive the
 * AEAD key + SAS matchCode, then [seal] the install-blob recipe.
 */
class QrSession private constructor(
    private val phonePrivKey: ByteArray,
    val phonePubKey: ByteArray,
) {
    private var kEnc: ByteArray? = null
    var matchCode: String? = null
        private set

    /**
     * Derive the shared secret with the browser's pubkey from the QR,
     * then HKDF-expand into (kEnc, matchCode). MUST be called before
     * [seal]. Returns the matchCode the user is supposed to compare
     * against the one on the browser screen.
     */
    fun pair(browserPubKey: ByteArray): String {
        require(browserPubKey.size == 32) { "browser pubkey must be 32 bytes (raw X25519)" }
        val shared = X25519.computeSharedSecret(phonePrivKey, browserPubKey)
        kEnc = QrRelay.hkdfSha256(
            ikm = shared,
            salt = "flagship/qr/v1".toByteArray(),
            info = "flagship/qr/enc/v1".toByteArray(),
            lengthBytes = 32,
        )
        val sasBits = QrRelay.hkdfSha256(
            ikm = shared,
            salt = "flagship/qr/v1".toByteArray(),
            info = "flagship/qr/sas/v1".toByteArray(),
            lengthBytes = 4,
        )
        val mc = QrRelay.matchCodeFromBytes(sasBits)
        matchCode = mc
        return mc
    }

    /**
     * AES-256-GCM seal of [plaintext] under the derived kEnc. Generates
     * a fresh 12-byte nonce on every call. Returns the
     * base64url-encoded (ciphertext, nonce) pair the deliver frame
     * carries on the wire.
     */
    fun seal(plaintext: ByteArray): Sealed {
        val key = kEnc ?: error("seal() before pair() — derive shared first")
        val nonce = ByteArray(12).also(rng::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ciphertext = cipher.doFinal(plaintext)
        return Sealed(
            ciphertextB64u = Base64URL.encode(ciphertext),
            nonceB64u = Base64URL.encode(nonce),
        )
    }

    data class Sealed(val ciphertextB64u: String, val nonceB64u: String)

    /**
     * Phase 3b (cross-device pairing, receiver side) — inverse of [seal].
     * AEAD-opens a base64url (ciphertext, nonce) pair delivered over the
     * relay under the derived kEnc. MUST be called after [pair]. A bad
     * tag throws (the GCM open fails) — the caller treats that as a
     * MitM / wrong-peer and discards.
     */
    fun open(ciphertextB64u: String, nonceB64u: String): ByteArray {
        val key = kEnc ?: error("open() before pair() — derive shared first")
        val ct = Base64URL.decode(ciphertextB64u) ?: error("ciphertext is not valid base64url")
        val nonce = Base64URL.decode(nonceB64u) ?: error("nonce is not valid base64url")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return cipher.doFinal(ct)
    }

    companion object {
        private val rng = SecureRandom()

        /** Generate a fresh phone-side X25519 keypair. */
        fun fresh(): QrSession {
            val priv = X25519.generatePrivateKey()
            val pub = X25519.publicFromPrivate(priv)
            return QrSession(priv, pub)
        }
    }
}
