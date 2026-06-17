// Kotlin mirror of Flagship/QrRelayProtocol.swift.
//
// X25519 ECDH + HKDF-SHA256 → AES-GCM AEAD key + 6-digit SAS match
// code. Phone-side of the QR relay; the browser counterpart lives in
// apps/web/public/heroQr.js.

package com.flagshipserver.app.core

import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

object QrRelay {
    /** Control apex host, via [Endpoints] (prod-default + test override). */
    val QR_HOST: String get() = Endpoints.controlHost
    val HKDF_SALT: ByteArray = "flagship/qr/v1".toByteArray()
    val ENC_INFO: ByteArray = "flagship/qr/enc/v1".toByteArray()
    val SAS_INFO: ByteArray = "flagship/qr/sas/v1".toByteArray()

    data class QrSession(val sid: String, val browserPublicKey: ByteArray) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is QrSession) return false
            return sid == other.sid && browserPublicKey.contentEquals(other.browserPublicKey)
        }
        override fun hashCode(): Int = sid.hashCode() * 31 + browserPublicKey.contentHashCode()
    }

    data class DerivedMaterial(val matchCode: String, val aeadKey: ByteArray)

    sealed class RelayError(msg: String) : Throwable(msg) {
        data class MalformedQrUrl(val why: String) : RelayError("QR URL: $why")
        object BadPublicKey : RelayError("Browser public key must be 32 raw X25519 bytes.")
        data class DerivationFailed(val why: String) : RelayError("Shared-secret derivation failed: $why")
    }

    /**
     * Accept one of:
     *   https://flagshipserver.com/qr?s=<sid>&k=<pkB>
     *   flagship://qr?s=<sid>&k=<pkB>
     *   s=<sid>&k=<pkB>
     */
    fun parseQrUrl(raw: String): QrSession {
        val text = raw.trim()
        if (text.isEmpty()) throw RelayError.MalformedQrUrl("empty")
        var s: String? = null
        var k: String? = null
        if ("?" in text) {
            val normalized = if (text.startsWith("flagship://"))
                text.replace("flagship://", "https://_/")
            else text
            val query = normalized.substringAfter('?', "")
            query.split('&').forEach { pair ->
                val (key, value) = pair.split('=', limit = 2).let {
                    if (it.size == 2) it[0] to it[1] else it[0] to ""
                }
                when (key) {
                    "s" -> s = value
                    "k" -> k = value
                }
            }
        } else if ("=" in text) {
            text.split('&').forEach { pair ->
                val (key, value) = pair.split('=', limit = 2).let {
                    if (it.size == 2) it[0] to it[1] else it[0] to ""
                }
                when (key) {
                    "s" -> s = value
                    "k" -> k = value
                }
            }
        }
        if (s.isNullOrEmpty() || k.isNullOrEmpty()) throw RelayError.MalformedQrUrl("missing s= or k=")
        val pk = Base64URL.decode(k!!) ?: throw RelayError.MalformedQrUrl("k is not valid base64url")
        if (pk.size != 32) throw RelayError.BadPublicKey
        return QrSession(s!!, pk)
    }

    /// Render the 6-digit SAS code with a space after the third digit —
    /// matches `formatMatchCode` in heroQr.js / create-server.js.
    fun formatMatchCode(code: String): String {
        if (code.length != 6) return code
        return code.substring(0, 3) + " " + code.substring(3)
    }

    /**
     * Phone-side derivation. The caller passes its fresh X25519 private
     * key + the browser's raw 32-byte public key from the QR URL.
     *
     * NOTE: Production should use Tink or BouncyCastle for X25519. This
     * function defines the contract; an implementation living in the
     * Android crypto module wires it up to the JCE / BouncyCastle
     * provider. Tests run against a deterministic mock derivation.
     */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, lengthBytes: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // Step 1: extract
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        // Step 2: expand
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(lengthBytes)
        var t = ByteArray(0)
        var counter = 1
        var written = 0
        while (written < lengthBytes) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val toCopy = minOf(t.size, lengthBytes - written)
            System.arraycopy(t, 0, out, written, toCopy)
            written += toCopy
            counter++
        }
        return out
    }

    fun matchCodeFromBytes(bytes: ByteArray): String {
        require(bytes.size >= 4)
        val u32 = ByteBuffer.wrap(bytes, 0, 4).int.toLong() and 0xFFFFFFFFL
        val n = (u32 % 1_000_000L).toInt()
        return "%06d".format(n)
    }
}

/// base64url (RFC 4648 §5) helpers — no padding. Mirrors the Swift
/// Base64URL enum + heroQr.js b64urlEncode/decode. Uses java.util.Base64
/// (API 26+; ours is minSdk 28) so the helper is reachable from plain-
/// JVM unit tests as well as Android.
object Base64URL {
    private val encoder = java.util.Base64.getUrlEncoder().withoutPadding()
    private val decoder = java.util.Base64.getUrlDecoder()

    fun encode(data: ByteArray): String = encoder.encodeToString(data)

    fun decode(s: String): ByteArray? = try {
        decoder.decode(s)
    } catch (_: IllegalArgumentException) {
        null
    }
}
