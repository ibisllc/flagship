// Shared helpers for the voi.ci / Messages ports (docs/voici-and-messages.md §7.1): JavaScript-faithful readers over
// kotlinx JsonElement values (a JSON string is never a number, `true` is never 1, numbers follow IEEE-754 doubles
// like JSON.parse), strict UTF-8, the check-outcome type, and the crypto primitives the TS uses from noble
// (Ed25519, P-256 ECDSA with IEEE P1363 signatures, HKDF-SHA256, AES-256-GCM).
//
// Public API: VoiciOutcome (Ok / Refused, `code` = "ok" or the refusal), VoiciKeyPair.
// Internal: VoiciJs (str, num, time, safeInt, isNum, isTrue, obj, arr, exactKeys, exactKeysOpt, parseJson,
// utf8Fatal, utf8, ed25519 / p256 / hkdf / gcm helpers).

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.ec.CustomNamedCurves
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.ECDomainParameters
import org.bouncycastle.crypto.params.ECPrivateKeyParameters
import org.bouncycastle.crypto.params.ECPublicKeyParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.signers.ECDSASigner
import org.bouncycastle.crypto.signers.HMacDSAKCalculator
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** The answer of a check: the accepted value, or the TypeScript refusal code. */
sealed class VoiciOutcome<out T> {
    data class Ok<T>(val value: T) : VoiciOutcome<T>()
    data class Refused(val reason: String) : VoiciOutcome<Nothing>()

    val ok: Boolean get() = this is Ok
    /** "ok" or the refusal code, as the shared vectors write it. */
    val code: String get() = when (this) {
        is Ok -> "ok"
        is Refused -> reason
    }
    fun valueOrNull(): T? = (this as? Ok<T>)?.value
}

class VoiciKeyPair(val seed: ByteArray, val publicKey: ByteArray)

internal object VoiciJs {
    const val MAX_SAFE = 9_007_199_254_740_991L

    fun str(e: JsonElement?): String? = if (e is JsonPrimitive && e !is JsonNull && e.isString) e.content else null

    /** A JSON number as JS would read it, or null for anything else (strings, booleans, null). */
    fun num(e: JsonElement?): Double? {
        if (e !is JsonPrimitive || e is JsonNull || e.isString) return null
        val c = e.content
        if (c == "true" || c == "false") return null
        return try {
            c.toDouble()
        } catch (_: NumberFormatException) {
            null
        }
    }

    fun isNum(e: JsonElement?): Boolean = num(e) != null

    /** Number.isSafeInteger: an integral double within ±(2^53 - 1). -0 reads as 0. */
    fun safeInt(e: JsonElement?): Long? {
        val d = num(e) ?: return null
        if (d.isNaN() || d.isInfinite() || d != Math.floor(d) || Math.abs(d) > MAX_SAFE.toDouble()) return null
        return d.toLong()
    }

    /** isTime: a safe integer >= 0. */
    fun time(e: JsonElement?): Long? = safeInt(e)?.takeIf { it >= 0 }

    fun isTrue(e: JsonElement?): Boolean = e is JsonPrimitive && e !is JsonNull && !e.isString && e.content == "true"
    fun isNull(e: JsonElement?): Boolean = e is JsonNull
    fun isNumEq(e: JsonElement?, n: Long): Boolean = num(e)?.let { it == n.toDouble() } ?: false

    fun obj(e: JsonElement?): JsonObject? = e as? JsonObject
    fun arr(e: JsonElement?): JsonArray? = e as? JsonArray

    /** voiciPage.ts exactKeys: exactly these keys. */
    fun exactKeys(o: JsonObject, keys: List<String>): Boolean = o.size == keys.size && keys.all { o.containsKey(it) }

    /** voiciMessages.ts exactKeys: every required key, nothing outside required + optional. */
    fun exactKeysOpt(o: JsonObject, required: List<String>, optional: List<String> = emptyList()): Boolean =
        required.all { o.containsKey(it) } && o.keys.all { it in required || it in optional }

    fun parseJson(text: String): JsonElement? = try {
        Json.parseToJsonElement(text)
    } catch (_: Exception) {
        null
    }

    fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    /** TextDecoder("utf-8", {fatal: true}). */
    fun utf8Fatal(b: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(b)).toString()
    } catch (_: Exception) {
        null
    }

    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    fun hex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) {
            val v = x.toInt() and 0xff
            sb.append("0123456789abcdef"[v shr 4]).append("0123456789abcdef"[v and 15])
        }
        return sb.toString()
    }

    // ── Ed25519 ──

    fun edPub(seed: ByteArray): ByteArray = PqHybrid.ed25519PublicKey(seed)
    fun edSign(seed: ByteArray, msg: ByteArray): ByteArray = PqHybrid.ed25519Sign(seed, msg)

    // ── P-256 ──

    private val P256 = CustomNamedCurves.getByName("secp256r1")
    private val DOMAIN = ECDomainParameters(P256.curve, P256.g, P256.n, P256.h)

    fun p256Verify(sig: ByteArray, msg: ByteArray, pub: ByteArray): Boolean = try {
        val q = DOMAIN.curve.decodePoint(pub)
        val v = ECDSASigner()
        v.init(false, ECPublicKeyParameters(q, DOMAIN))
        v.verifySignature(sha256(msg), BigInteger(1, sig.copyOfRange(0, 32)), BigInteger(1, sig.copyOfRange(32, 64)))
    } catch (_: Exception) {
        false
    }

    /** RFC 6979 deterministic, low-S, P1363 r||s. */
    fun p256Sign(priv: ByteArray, msg: ByteArray): ByteArray {
        val s = ECDSASigner(HMacDSAKCalculator(SHA256Digest()))
        s.init(true, ECPrivateKeyParameters(BigInteger(1, priv), DOMAIN))
        val rs = s.generateSignature(sha256(msg))
        var sv = rs[1]
        if (sv > DOMAIN.n.shiftRight(1)) sv = DOMAIN.n.subtract(sv)
        return fixed32(rs[0]) + fixed32(sv)
    }

    fun p256PublicKey(priv: ByteArray): ByteArray = DOMAIN.g.multiply(BigInteger(1, priv)).normalize().getEncoded(false)

    private fun fixed32(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    // ── HKDF-SHA256 (salt empty) and AES-256-GCM ──

    fun hkdf32(ikm: ByteArray, info: String): ByteArray {
        val g = HKDFBytesGenerator(SHA256Digest())
        g.init(HKDFParameters(ikm, ByteArray(0), utf8(info)))
        return ByteArray(32).also { g.generateBytes(it, 0, 32) }
    }

    fun gcmEncrypt(key: ByteArray, nonce: ByteArray, aad: ByteArray, pt: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        return c.doFinal(pt)
    }

    /** Throws on a failed tag. */
    fun gcmDecrypt(key: ByteArray, nonce: ByteArray, aad: ByteArray, ct: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        return c.doFinal(ct)
    }
}
