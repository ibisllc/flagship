// The signed web envelope and the canonical-JSON / base64 rules every voi.ci and Messages record uses
// (docs/voici-and-messages.md §7.1). Kotlin twin of packages/protocol/src/webEnvelope.ts; the shared vectors in
// packages/protocol/test-vectors/messages/ lock the bytes.
//
//   flagship/web-envelope/v1|<kind>|<audience>|<conv>|<from>|<msgId>|<seq>|<sentAt>|<H(bodyBytes)>|<H(credBytes)>
//
// Canonical JSON: object keys sorted by UTF-16 code units, no whitespace, strings escaped as JSON.stringify does,
// safe integers only (no floats, no -0), null, booleans, arrays. Lone surrogates, floats and other values throw.
//
// Public API (object WebEnvelopes): TAG_WEB_ENVELOPE, WEB_ENVELOPE_MAX_BYTES, WEB_ENVELOPE_MAX_BODY_BYTES,
// canonicalJson, canonicalJsonBytes, b64Encode, b64Decode, sha256Hex, hexToBytes, isLowerHex, canonicalWebEnvelope,
// parseWebEnvelope, signWebEnvelopeEd25519, signWebEnvelopeP256, verifyWebEnvelopeSignature, p256VerifyP1363,
// ed25519VerifyHex. Data class WebEnvelope (+ toJson).

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class WebEnvelope(
    val kind: String,
    val audience: String,
    val conv: String,
    val from: String,
    val msgId: String,
    val seq: Long,
    val sentAt: Long,
    val bodyB64: String,
    val cred: JsonObject,
    /** "ed25519" or "p256"; ignored by the canonical bytes. */
    val sigAlg: String = "",
    val sig: String = "",
) {
    val v: Int get() = 1

    fun toJson(): JsonObject = JsonObject(
        linkedMapOf(
            "v" to JsonPrimitive(1),
            "kind" to JsonPrimitive(kind),
            "audience" to JsonPrimitive(audience),
            "conv" to JsonPrimitive(conv),
            "from" to JsonPrimitive(from),
            "msgId" to JsonPrimitive(msgId),
            "seq" to JsonPrimitive(seq),
            "sentAt" to JsonPrimitive(sentAt),
            "bodyB64" to JsonPrimitive(bodyB64),
            "cred" to cred,
            "sigAlg" to JsonPrimitive(sigAlg),
            "sig" to JsonPrimitive(sig),
        ),
    )
}

object WebEnvelopes {
    const val TAG_WEB_ENVELOPE = "flagship/web-envelope/v1"
    const val WEB_ENVELOPE_MAX_BYTES = 64 * 1024
    const val WEB_ENVELOPE_MAX_BODY_BYTES = 24 * 1024

    // ── small encoders ──

    fun sha256Hex(b: ByteArray): String = VoiciJs.hex(VoiciJs.sha256(b))
    fun sha256Hex(s: String): String = sha256Hex(VoiciJs.utf8(s))

    private val LOWER_HEX = Regex("^[0-9a-f]*$")

    fun isLowerHex(s: String?, bytes: Int? = null): Boolean {
        if (s == null || s.length % 2 != 0 || !LOWER_HEX.matches(s)) return false
        return bytes == null || s.length == bytes * 2
    }

    fun isLowerHex(e: JsonElement?, bytes: Int? = null): Boolean = isLowerHex(VoiciJs.str(e), bytes)

    fun hexToBytes(h: String): ByteArray {
        require(isLowerHex(h)) { "not lowercase hex" }
        return ByteArray(h.length / 2) { i -> h.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }

    private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private val B64_SHAPE = Regex("^[A-Za-z0-9+/]*={0,2}$")

    /** Standard base64 with padding. */
    fun b64Encode(b: ByteArray): String {
        val sb = StringBuilder()
        var i = 0
        while (i < b.size) {
            val b0 = b[i].toInt() and 0xff
            val b1 = if (i + 1 < b.size) b[i + 1].toInt() and 0xff else 0
            val b2 = if (i + 2 < b.size) b[i + 2].toInt() and 0xff else 0
            val n = (b0 shl 16) or (b1 shl 8) or b2
            sb.append(B64[(n shr 18) and 63]).append(B64[(n shr 12) and 63])
            sb.append(if (i + 1 < b.size) B64[(n shr 6) and 63] else '=')
            sb.append(if (i + 2 < b.size) B64[n and 63] else '=')
            i += 3
        }
        return sb.toString()
    }

    /** Strict standard base64: padded, canonical (re-encodes to the same string), else null. */
    fun b64Decode(s: String?): ByteArray? {
        if (s == null || s.length % 4 != 0 || !B64_SHAPE.matches(s)) return null
        val pad = if (s.endsWith("==")) 2 else if (s.endsWith("=")) 1 else 0
        val out = ByteArray((s.length / 4) * 3 - pad)
        var o = 0
        var i = 0
        while (i < s.length) {
            val v = IntArray(4) { k -> if (s[i + k] == '=') 0 else B64.indexOf(s[i + k]) }
            if (v.any { it < 0 }) return null
            val n = (v[0] shl 18) or (v[1] shl 12) or (v[2] shl 6) or v[3]
            if (o < out.size) out[o++] = ((n shr 16) and 0xff).toByte()
            if (o < out.size) out[o++] = ((n shr 8) and 0xff).toByte()
            if (o < out.size) out[o++] = (n and 0xff).toByte()
            i += 4
        }
        return if (b64Encode(out) == s) out else null
    }

    fun b64Decode(e: JsonElement?): ByteArray? = b64Decode(VoiciJs.str(e))

    // ── canonical JSON ──

    private fun jsonString(s: String, out: StringBuilder) {
        out.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i].code
            if (c in 0xd800..0xdbff) {
                val d = if (i + 1 < s.length) s[i + 1].code else -1
                if (d !in 0xdc00..0xdfff) throw IllegalArgumentException("canonical JSON: lone surrogate")
                out.append(s[i]).append(s[i + 1])
                i += 2
                continue
            }
            if (c in 0xdc00..0xdfff) throw IllegalArgumentException("canonical JSON: lone surrogate")
            when {
                c == 0x22 -> out.append("\\\"")
                c == 0x5c -> out.append("\\\\")
                c == 0x08 -> out.append("\\b")
                c == 0x0c -> out.append("\\f")
                c == 0x0a -> out.append("\\n")
                c == 0x0d -> out.append("\\r")
                c == 0x09 -> out.append("\\t")
                c < 0x20 -> out.append("\\u").append(c.toString(16).padStart(4, '0'))
                else -> out.append(s[i])
            }
            i++
        }
        out.append('"')
    }

    private fun writeCanonical(v: Any?, out: StringBuilder) {
        when (v) {
            null, JsonNull -> out.append("null")
            is JsonPrimitive -> {
                if (v.isString) {
                    jsonString(v.content, out)
                } else if (v.content == "true" || v.content == "false") {
                    out.append(v.content)
                } else {
                    val d = VoiciJs.num(v) ?: throw IllegalArgumentException("canonical JSON: unsupported value")
                    if (d.isNaN() || d.isInfinite() || d != Math.floor(d) || Math.abs(d) > VoiciJs.MAX_SAFE.toDouble() ||
                        (d == 0.0 && 1.0 / d < 0)
                    ) {
                        throw IllegalArgumentException("canonical JSON: only safe integers")
                    }
                    out.append(d.toLong().toString())
                }
            }
            is JsonArray -> {
                out.append('[')
                v.forEachIndexed { i, x -> if (i > 0) out.append(','); writeCanonical(x, out) }
                out.append(']')
            }
            is JsonObject -> writeObject(v.keys, { v[it] }, out)
            is String -> jsonString(v, out)
            is Boolean -> out.append(v.toString())
            is Int -> writeCanonical(JsonPrimitive(v), out)
            is Long -> {
                if (Math.abs(v) > VoiciJs.MAX_SAFE) throw IllegalArgumentException("canonical JSON: only safe integers")
                out.append(v.toString())
            }
            is Map<*, *> -> {
                val m = v
                val keys = m.keys.map { it as? String ?: throw IllegalArgumentException("canonical JSON: non-string key") }.toSet()
                writeObject(keys, { m[it] }, out)
            }
            is List<*> -> {
                out.append('[')
                v.forEachIndexed { i, x -> if (i > 0) out.append(','); writeCanonical(x, out) }
                out.append(']')
            }
            else -> throw IllegalArgumentException("canonical JSON: unsupported value")
        }
    }

    private fun writeObject(keys: Set<String>, get: (String) -> Any?, out: StringBuilder) {
        out.append('{')
        keys.sorted().forEachIndexed { i, k ->
            if (i > 0) out.append(',')
            jsonString(k, out)
            out.append(':')
            writeCanonical(get(k), out)
        }
        out.append('}')
    }

    /**
     * Canonical JSON text of a JSON value: a kotlinx JsonElement, or plain Kotlin values (String, Boolean, Int, Long,
     * null, Map<String, *>, List<*>). Throws IllegalArgumentException on floats, unsafe integers, lone surrogates.
     */
    fun canonicalJson(v: Any?): String = StringBuilder().also { writeCanonical(v, it) }.toString()

    fun canonicalJsonBytes(v: Any?): ByteArray = VoiciJs.utf8(canonicalJson(v))

    // ── the envelope ──

    private val KIND = Regex("^[a-z][a-z0-9-]{0,31}$")
    private val FIELD = Regex("^[a-z0-9-]*$")
    private val ENVELOPE_KEYS = listOf("audience", "bodyB64", "conv", "cred", "from", "kind", "msgId", "sentAt", "seq", "sig", "sigAlg", "v")

    private fun noSepCtrl(name: String, v: String) {
        for (ch in v) {
            val c = ch.code
            if (c == 0x7c || c <= 0x1f || c == 0x7f) throw IllegalArgumentException("$TAG_WEB_ENVELOPE: $name has a separator or control")
        }
    }

    /** The signed bytes. Throws on a field that cannot be joined. */
    fun canonicalWebEnvelope(e: WebEnvelope): ByteArray {
        if (!KIND.matches(e.kind)) throw IllegalArgumentException("$TAG_WEB_ENVELOPE: bad kind")
        noSepCtrl("audience", e.audience)
        noSepCtrl("conv", e.conv)
        noSepCtrl("from", e.from)
        noSepCtrl("msgId", e.msgId)
        if (e.seq < 1 || e.seq > VoiciJs.MAX_SAFE) throw IllegalArgumentException("$TAG_WEB_ENVELOPE: bad seq")
        if (e.sentAt < 0 || e.sentAt > VoiciJs.MAX_SAFE) throw IllegalArgumentException("$TAG_WEB_ENVELOPE: bad sentAt")
        val body = b64Decode(e.bodyB64) ?: throw IllegalArgumentException("$TAG_WEB_ENVELOPE: bodyB64 is not canonical base64")
        return VoiciJs.utf8(
            listOf(
                TAG_WEB_ENVELOPE, e.kind, e.audience, e.conv, e.from, e.msgId, e.seq.toString(), e.sentAt.toString(),
                sha256Hex(body), sha256Hex(canonicalJsonBytes(e.cred)),
            ).joinToString("|"),
        )
    }

    /**
     * Strict outer shape of an untrusted envelope (JSON text as a String, or a parsed JsonElement): exactly the
     * twelve keys, types, hex lengths for msgId (16 bytes) and the signature, canonical base64. Null when malformed.
     */
    fun parseWebEnvelope(input: Any?, maxBodyBytes: Int = WEB_ENVELOPE_MAX_BODY_BYTES): WebEnvelope? {
        val v: JsonElement? = when (input) {
            is String -> VoiciJs.parseJson(input) ?: return null
            is JsonElement -> input
            else -> return null
        }
        val r = VoiciJs.obj(v) ?: return null
        val keys = r.keys.sorted()
        if (keys != ENVELOPE_KEYS) return null
        if (!VoiciJs.isNumEq(r["v"], 1)) return null
        val kind = VoiciJs.str(r["kind"]) ?: return null
        if (!KIND.matches(kind)) return null
        val f = arrayOfNulls<String>(3)
        for ((i, k) in listOf("audience", "conv", "from").withIndex()) {
            val s = VoiciJs.str(r[k]) ?: return null
            if (s.length > 256 || !FIELD.matches(s)) return null
            f[i] = s
        }
        if (!isLowerHex(r["msgId"], 16)) return null
        val seq = VoiciJs.time(r["seq"]) ?: return null
        if (seq < 1) return null
        val sentAt = VoiciJs.time(r["sentAt"]) ?: return null
        val body = b64Decode(r["bodyB64"]) ?: return null
        if (body.size > maxBodyBytes) return null
        val cred = VoiciJs.obj(r["cred"]) ?: return null
        try {
            canonicalJson(cred)
        } catch (_: IllegalArgumentException) {
            return null
        }
        val sigAlg = VoiciJs.str(r["sigAlg"])
        if (sigAlg != "ed25519" && sigAlg != "p256") return null
        if (!isLowerHex(r["sig"], 64)) return null
        return WebEnvelope(kind, f[0]!!, f[1]!!, f[2]!!, VoiciJs.str(r["msgId"])!!, seq, sentAt, VoiciJs.str(r["bodyB64"])!!, cred, sigAlg, VoiciJs.str(r["sig"])!!)
    }

    fun signWebEnvelopeEd25519(e: WebEnvelope, seed: ByteArray): WebEnvelope {
        val unsigned = e.copy(sigAlg = "ed25519", sig = "")
        return unsigned.copy(sig = VoiciJs.hex(VoiciJs.edSign(seed, canonicalWebEnvelope(unsigned))))
    }

    /** Deterministic (RFC 6979, low-S) P-256 signature: for vectors and tests; browsers sign with WebCrypto. */
    fun signWebEnvelopeP256(e: WebEnvelope, privateKey: ByteArray): WebEnvelope {
        val unsigned = e.copy(sigAlg = "p256", sig = "")
        return unsigned.copy(sig = VoiciJs.hex(VoiciJs.p256Sign(privateKey, canonicalWebEnvelope(unsigned))))
    }

    /** ECDSA P-256 / SHA-256, IEEE P1363 signature (hex 128), uncompressed SEC1 key (hex 130). High-S accepted. */
    fun p256VerifyP1363(sigHex: String?, msg: ByteArray, pubHex: String?): Boolean {
        if (!isLowerHex(sigHex, 64) || !isLowerHex(pubHex, 65) || !pubHex!!.startsWith("04")) return false
        return VoiciJs.p256Verify(hexToBytes(sigHex!!), msg, hexToBytes(pubHex))
    }

    fun ed25519VerifyHex(sigHex: String?, msg: ByteArray, pubHex: String?): Boolean {
        if (!isLowerHex(sigHex, 64) || !isLowerHex(pubHex, 32)) return false
        return try {
            PqHybrid.ed25519VerifyStrict(hexToBytes(sigHex!!), msg, hexToBytes(pubHex!!))
        } catch (_: Exception) {
            false
        }
    }

    /** Checks `sig` over the canonical bytes with `signerPub` (Ed25519 hex 64, or P-256 SEC1 uncompressed hex 130). */
    fun verifyWebEnvelopeSignature(e: WebEnvelope, signerPub: String): Boolean {
        val bytes = try {
            canonicalWebEnvelope(e)
        } catch (_: IllegalArgumentException) {
            return false
        }
        return if (e.sigAlg == "p256") p256VerifyP1363(e.sig, bytes, signerPub) else ed25519VerifyHex(e.sig, bytes, signerPub)
    }
}
