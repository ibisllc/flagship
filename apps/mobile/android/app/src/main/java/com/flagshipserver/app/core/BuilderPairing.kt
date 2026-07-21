package com.flagshipserver.app.core

import java.security.MessageDigest

/**
 * Phone-side of the phone↔desktop-builder pairing (Kotlin mirror of the
 * iOS shared BuilderPairing + apps/builder-mac). The SAS + AES-GCM reuse
 * QrRelay/QrSession (identical constants); this only adds the
 * builder-specific short-code → session-id mapping + QR parsing.
 *
 * The builder shows `flagship://builder?c=<code>&k=<builderPkB64url>` plus an
 * 8-char short code. A scanning phone gets the code AND the pubkey; a
 * typed code gets only the code and learns the pubkey over the relay
 * (`builder-hello`). Both derive the session id from the code identically.
 *
 * Pinned to the cross-platform vector in apps/com builderPairingVector.test.ts.
 */
object BuilderPairing {
    private val SID_TAG = "flagship/builder-sid/v1".toByteArray()
    const val CODE_BYTE_COUNT = 5

    data class Scanned(val codeBytes: ByteArray, val builderPublicKey: ByteArray?) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Scanned) return false
            if (!codeBytes.contentEquals(other.codeBytes)) return false
            val a = builderPublicKey; val b = other.builderPublicKey
            return if (a == null || b == null) a == null && b == null else a.contentEquals(b)
        }
        override fun hashCode(): Int = codeBytes.contentHashCode()
    }

    /** Relay session id (`<sid>` in `/builder-pipe/<sid>`). */
    fun sessionId(codeBytes: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(SID_TAG)
        md.update(codeBytes)
        return Base64URL.encode(md.digest()).take(32)
    }

    /** Decode a typed short code (case-insensitive, dash/space-tolerant). */
    fun codeBytes(humanCode: String): ByteArray? {
        val cleaned = humanCode.uppercase().filter { it != ' ' && it != '-' }
        val bytes = Base32.decode(cleaned) ?: return null
        return if (bytes.size == CODE_BYTE_COUNT) bytes else null
    }

    /**
     * Parse a scanned builder QR or a typed short code. Accepts
     * `flagship://builder?c=<code>&k=<pk>`, `c=<code>&k=<pk>`, or a bare code.
     */
    fun parse(raw: String): Scanned? {
        val text = raw.trim()
        if (text.isEmpty()) return null

        if (!text.contains("=") && !text.contains("?")) {
            val code = codeBytes(text) ?: return null
            return Scanned(code, null)
        }

        val query = text.substringAfter("?", text)
        var c: String? = null
        var k: String? = null
        for (pair in query.split("&")) {
            val kv = pair.split("=", limit = 2)
            if (kv.size != 2) continue
            when (kv[0]) {
                "c" -> c = kv[1]
                "k" -> k = kv[1]
            }
        }
        val codeStr = c ?: return null
        val code = codeBytes(codeStr) ?: return null
        val pk = k?.let { Base64URL.decode(it) }?.takeIf { it.size == 32 }
        return Scanned(code, pk)
    }

    fun looksLikeBuilderCode(raw: String): Boolean = parse(raw) != null
}

/** RFC 4648 base32 (uppercase A–Z2–7, no padding). Mirrors apps/builder-mac. */
object Base32 {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    fun encode(data: ByteArray): String {
        val out = StringBuilder()
        var buffer = 0
        var bits = 0
        for (b in data) {
            buffer = (buffer shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) { bits -= 5; out.append(ALPHABET[(buffer shr bits) and 0x1f]) }
        }
        if (bits > 0) out.append(ALPHABET[(buffer shl (5 - bits)) and 0x1f])
        return out.toString()
    }

    fun decode(s: String): ByteArray? {
        val out = ArrayList<Byte>()
        var buffer = 0
        var bits = 0
        for (ch in s) {
            val v = ALPHABET.indexOf(ch)
            if (v < 0) return null
            buffer = (buffer shl 5) or v
            bits += 5
            if (bits >= 8) { bits -= 8; out.add(((buffer shr bits) and 0xff).toByte()) }
        }
        return out.toByteArray()
    }
}
