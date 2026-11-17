// Oblivious HTTP (RFC 9458) with Binary HTTP (RFC 9292): the Kotlin twin of packages/protocol/src/ohttp.ts.
// The phone sends its voucher spends to `.com`'s gateway through a third-party relay, so the relay sees the
// phone's address but only ciphertext, and `.com` sees the spend but only the relay's address
// (docs/outbound-proxy.md "OHTTP", docs/payments-privacy-and-rails.md §5.4).
//
// One suite: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM (RFC 9180 ids 0x0020 / 0x0001 / 0x0001).
// The ephemeral key and the response nonce can be injected so test-vectors/ohttp/vectors.json pins every byte.

package com.flagshipserver.app.core.ohttp

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.macs.HMac
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.math.ec.rfc7748.X25519
import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class OhttpException(val code: String, message: String) : Exception(message)

data class OhttpKeyConfig(val keyId: Int, val publicKey: ByteArray) {
    override fun equals(other: Any?) = other is OhttpKeyConfig && other.keyId == keyId && other.publicKey.contentEquals(publicKey)
    override fun hashCode() = keyId * 31 + publicKey.contentHashCode()
}

data class OhttpGatewayKey(val keyId: Int, val privateKey: ByteArray, val publicKey: ByteArray)

/** What a side keeps to seal or open the response. */
class OhttpResponseContext(val enc: ByteArray, val secret: ByteArray)

class OhttpEncapsulated(val encapsulated: ByteArray, val context: OhttpResponseContext)

data class BhttpRequest(
    val method: String,
    val scheme: String,
    val authority: String,
    val path: String,
    val headers: List<Pair<String, String>>,
    val body: ByteArray,
)

data class BhttpResponse(val status: Int, val headers: List<Pair<String, String>>, val body: ByteArray)

object Ohttp {
    const val REQUEST_MEDIA_TYPE = "message/ohttp-req"
    const val RESPONSE_MEDIA_TYPE = "message/ohttp-res"
    const val KEM_X25519_HKDF_SHA256 = 0x0020
    const val KDF_HKDF_SHA256 = 0x0001
    const val AEAD_AES_128_GCM = 0x0001

    private const val NK = 16
    private const val NN = 12
    private const val NH = 32
    private const val NENC = 32
    private val SECRET_LEN = maxOf(NN, NK)
    private val rng = SecureRandom()

    private fun te(s: String) = s.toByteArray(Charsets.UTF_8)
    private fun u16(n: Int) = byteArrayOf(((n shr 8) and 0xff).toByte(), (n and 0xff).toByte())
    private fun cat(vararg parts: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        for (p in parts) out.write(p)
        return out.toByteArray()
    }
    private fun ByteArray.u8(i: Int) = this[i].toInt() and 0xff
    private fun ByteArray.u16At(i: Int) = (u8(i) shl 8) or u8(i + 1)

    // ------------------------------------------------------------ HKDF-SHA256 (RFC 5869)

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val m = HMac(SHA256Digest())
        m.init(KeyParameter(key))
        m.update(data, 0, data.size)
        return ByteArray(32).also { m.doFinal(it, 0) }
    }

    internal fun hkdfExtract(salt: ByteArray, ikm: ByteArray): ByteArray = hmac(salt, ikm)

    internal fun hkdfExpand(prk: ByteArray, info: ByteArray, len: Int): ByteArray {
        val out = ByteArrayOutputStream()
        var t = ByteArray(0)
        var i = 1
        while (out.size() < len) {
            t = hmac(prk, cat(t, info, byteArrayOf(i.toByte())))
            out.write(t)
            i++
        }
        return out.toByteArray().copyOf(len)
    }

    // ------------------------------------------------------------ HPKE (RFC 9180, base mode)

    private val KEM_SUITE = cat(te("KEM"), u16(KEM_X25519_HKDF_SHA256))
    private val HPKE_SUITE = cat(te("HPKE"), u16(KEM_X25519_HKDF_SHA256), u16(KDF_HKDF_SHA256), u16(AEAD_AES_128_GCM))
    private val HPKE_V1 = te("HPKE-v1")

    private fun labeledExtract(suite: ByteArray, salt: ByteArray, label: String, ikm: ByteArray) =
        hkdfExtract(salt, cat(HPKE_V1, suite, te(label), ikm))

    private fun labeledExpand(suite: ByteArray, prk: ByteArray, label: String, info: ByteArray, len: Int) =
        hkdfExpand(prk, cat(u16(len), HPKE_V1, suite, te(label), info), len)

    private fun kemSharedSecret(dh: ByteArray, enc: ByteArray, pkR: ByteArray): ByteArray {
        val eaePrk = labeledExtract(KEM_SUITE, ByteArray(0), "eae_prk", dh)
        return labeledExpand(KEM_SUITE, eaePrk, "shared_secret", cat(enc, pkR), 32)
    }

    private class HpkeContext(val key: ByteArray, val baseNonce: ByteArray, val exporterSecret: ByteArray)

    private fun keySchedule(sharedSecret: ByteArray, info: ByteArray): HpkeContext {
        val empty = ByteArray(0)
        val pskIdHash = labeledExtract(HPKE_SUITE, empty, "psk_id_hash", empty)
        val infoHash = labeledExtract(HPKE_SUITE, empty, "info_hash", info)
        val ctx = cat(byteArrayOf(0), pskIdHash, infoHash)
        val secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", empty)
        return HpkeContext(
            labeledExpand(HPKE_SUITE, secret, "key", ctx, NK),
            labeledExpand(HPKE_SUITE, secret, "base_nonce", ctx, NN),
            labeledExpand(HPKE_SUITE, secret, "exp", ctx, NH),
        )
    }

    private fun hpkeExport(ctx: HpkeContext, exporterContext: ByteArray, len: Int) =
        labeledExpand(HPKE_SUITE, ctx.exporterSecret, "sec", exporterContext, len)

    // ------------------------------------------------------------ X25519 and AES-GCM

    fun x25519Public(privateKey: ByteArray): ByteArray = ByteArray(32).also { X25519.scalarMultBase(privateKey, 0, it, 0) }

    private fun x25519(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        val out = ByteArray(32)
        X25519.scalarMult(privateKey, 0, publicKey, 0, out, 0)
        if (out.all { it == 0.toByte() }) throw OhttpException("decrypt", "low-order public key")
        return out
    }

    private fun gcm(mode: Int, key: ByteArray, nonce: ByteArray, data: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return c.doFinal(data)
    }

    // ------------------------------------------------------------ key configuration (RFC 9458 §3)

    fun gatewayKey(keyId: Int, privateKey: ByteArray): OhttpGatewayKey {
        require(keyId in 0..255) { "keyId must be 0..255" }
        require(privateKey.size == 32) { "privateKey must be 32 bytes" }
        return OhttpGatewayKey(keyId, privateKey.copyOf(), x25519Public(privateKey))
    }

    fun encodeKeyConfig(c: OhttpKeyConfig): ByteArray =
        cat(byteArrayOf(c.keyId.toByte()), u16(KEM_X25519_HKDF_SHA256), c.publicKey, u16(4), u16(KDF_HKDF_SHA256), u16(AEAD_AES_128_GCM))

    /** One key configuration; null unless it offers our KEM and suite. */
    fun parseKeyConfig(b: ByteArray): OhttpKeyConfig? {
        if (b.size < 1 + 2 + NENC + 2) return null
        if (b.u16At(1) != KEM_X25519_HKDF_SHA256) return null
        val publicKey = b.copyOfRange(3, 3 + NENC)
        var o = 3 + NENC
        val len = b.u16At(o)
        o += 2
        if (len % 4 != 0 || o + len != b.size) return null
        var i = o
        while (i < o + len) {
            if (b.u16At(i) == KDF_HKDF_SHA256 && b.u16At(i + 2) == AEAD_AES_128_GCM) return OhttpKeyConfig(b.u8(0), publicKey)
            i += 4
        }
        return null
    }

    fun keyConfigFromHex(hex: String): OhttpKeyConfig? {
        if (!Regex("^([0-9a-fA-F]{2})+$").matches(hex)) return null
        return parseKeyConfig(ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() })
    }

    // ------------------------------------------------------------ encapsulation (RFC 9458 §4)

    private val REQUEST_LABEL = te("message/bhttp request")
    private val RESPONSE_LABEL = te("message/bhttp response")

    private fun header(keyId: Int) =
        cat(byteArrayOf(keyId.toByte()), u16(KEM_X25519_HKDF_SHA256), u16(KDF_HKDF_SHA256), u16(AEAD_AES_128_GCM))

    /** Client: encrypt [request] (Binary HTTP) for the gateway. [ephemeralPrivateKey] is a test seam. */
    fun encapsulateRequest(config: OhttpKeyConfig, request: ByteArray, ephemeralPrivateKey: ByteArray? = null): OhttpEncapsulated {
        val skE = ephemeralPrivateKey?.copyOf() ?: ByteArray(32).also(rng::nextBytes)
        val enc = x25519Public(skE)
        val dh = x25519(skE, config.publicKey)
        val hdr = header(config.keyId)
        val ctx = keySchedule(kemSharedSecret(dh, enc, config.publicKey), cat(REQUEST_LABEL, byteArrayOf(0), hdr))
        val ct = gcm(Cipher.ENCRYPT_MODE, ctx.key, ctx.baseNonce, request)
        return OhttpEncapsulated(cat(hdr, enc, ct), OhttpResponseContext(enc, hpkeExport(ctx, RESPONSE_LABEL, SECRET_LEN)))
    }

    /** Gateway: decrypt an Encapsulated Request (tests and the mock relay only). */
    fun decapsulateRequest(keys: List<OhttpGatewayKey>, encapsulated: ByteArray): Pair<ByteArray, OhttpResponseContext> {
        if (encapsulated.size < 7 + NENC + 16) throw OhttpException("format", "encapsulated request too short")
        val key = keys.firstOrNull { it.keyId == encapsulated.u8(0) }
        if (key == null || encapsulated.u16At(1) != KEM_X25519_HKDF_SHA256 || encapsulated.u16At(3) != KDF_HKDF_SHA256 ||
            encapsulated.u16At(5) != AEAD_AES_128_GCM
        ) throw OhttpException("key", "unknown key or suite")
        val hdr = encapsulated.copyOfRange(0, 7)
        val enc = encapsulated.copyOfRange(7, 7 + NENC)
        val ct = encapsulated.copyOfRange(7 + NENC, encapsulated.size)
        return try {
            val dh = x25519(key.privateKey, enc)
            val ctx = keySchedule(kemSharedSecret(dh, enc, key.publicKey), cat(REQUEST_LABEL, byteArrayOf(0), hdr))
            gcm(Cipher.DECRYPT_MODE, ctx.key, ctx.baseNonce, ct) to OhttpResponseContext(enc, hpkeExport(ctx, RESPONSE_LABEL, SECRET_LEN))
        } catch (e: Exception) {
            throw OhttpException("decrypt", "could not decrypt the request")
        }
    }

    private fun responseKeyNonce(context: OhttpResponseContext, responseNonce: ByteArray): Pair<ByteArray, ByteArray> {
        val prk = hkdfExtract(cat(context.enc, responseNonce), context.secret)
        return hkdfExpand(prk, te("key"), NK) to hkdfExpand(prk, te("nonce"), NN)
    }

    /** Gateway: encrypt [response] (Binary HTTP). [responseNonce] is a test seam. */
    fun encapsulateResponse(context: OhttpResponseContext, response: ByteArray, responseNonce: ByteArray? = null): ByteArray {
        val nonce = responseNonce?.copyOf() ?: ByteArray(SECRET_LEN).also(rng::nextBytes)
        val (k, n) = responseKeyNonce(context, nonce)
        return cat(nonce, gcm(Cipher.ENCRYPT_MODE, k, n, response))
    }

    /** Client: decrypt an Encapsulated Response. */
    fun decapsulateResponse(context: OhttpResponseContext, encapsulated: ByteArray): ByteArray {
        if (encapsulated.size < SECRET_LEN + 16) throw OhttpException("format", "encapsulated response too short")
        return try {
            val (k, n) = responseKeyNonce(context, encapsulated.copyOfRange(0, SECRET_LEN))
            gcm(Cipher.DECRYPT_MODE, k, n, encapsulated.copyOfRange(SECRET_LEN, encapsulated.size))
        } catch (e: Exception) {
            throw OhttpException("decrypt", "could not decrypt the response")
        }
    }

    // ------------------------------------------------------------ Binary HTTP, known-length (RFC 9292)

    private fun varint(n: Long): ByteArray = when {
        n < 0x40 -> byteArrayOf(n.toByte())
        n < 0x4000 -> byteArrayOf((0x40 or (n shr 8).toInt()).toByte(), (n and 0xff).toByte())
        n < 0x40000000 -> byteArrayOf(
            (0x80 or (n shr 24).toInt()).toByte(), ((n shr 16) and 0xff).toByte(), ((n shr 8) and 0xff).toByte(), (n and 0xff).toByte(),
        )
        else -> throw IllegalArgumentException("value too large")
    }

    private fun lp(b: ByteArray) = cat(varint(b.size.toLong()), b)

    private fun fieldSection(headers: List<Pair<String, String>>): ByteArray =
        lp(cat(*headers.map { (n, v) -> cat(lp(te(n.lowercase())), lp(te(v))) }.toTypedArray()))

    private class Reader(val b: ByteArray) {
        var o = 0
        fun done() = o >= b.size
        fun varint(): Long {
            if (o >= b.size) throw OhttpException("format", "truncated message")
            val first = b[o].toInt() and 0xff
            val len = 1 shl (first shr 6)
            if (o + len > b.size) throw OhttpException("format", "truncated message")
            if (len == 8) throw OhttpException("format", "value too large")
            var v = (first and 0x3f).toLong()
            for (i in 1 until len) v = v * 256 + (b[o + i].toInt() and 0xff)
            o += len
            return v
        }
        fun bytes(): ByteArray {
            val n = varint()
            if (o + n > b.size) throw OhttpException("format", "truncated message")
            val out = b.copyOfRange(o, o + n.toInt())
            o += n.toInt()
            return out
        }
        fun text() = bytes().toString(Charsets.UTF_8)
        fun fields(): List<Pair<String, String>> {
            if (done()) return emptyList()
            val section = Reader(bytes())
            val out = mutableListOf<Pair<String, String>>()
            while (!section.done()) out += section.text() to section.text()
            return out
        }
    }

    fun encodeBhttpRequest(r: BhttpRequest): ByteArray = cat(
        varint(0), lp(te(r.method)), lp(te(r.scheme)), lp(te(r.authority)), lp(te(r.path)), fieldSection(r.headers), lp(r.body), varint(0),
    )

    fun decodeBhttpRequest(b: ByteArray): BhttpRequest {
        val r = Reader(b)
        if (r.varint() != 0L) throw OhttpException("format", "not a known-length request")
        val method = r.text()
        val scheme = r.text()
        val authority = r.text()
        val path = r.text()
        val headers = r.fields()
        val body = if (r.done()) ByteArray(0) else r.bytes()
        return BhttpRequest(method, scheme, authority, path, headers, body)
    }

    fun encodeBhttpResponse(r: BhttpResponse): ByteArray =
        cat(varint(1), varint(r.status.toLong()), fieldSection(r.headers), lp(r.body), varint(0))

    fun decodeBhttpResponse(b: ByteArray): BhttpResponse {
        val r = Reader(b)
        if (r.varint() != 1L) throw OhttpException("format", "not a known-length response")
        var status = r.varint()
        while (status in 100..199) {
            r.fields()
            status = r.varint()
        }
        val headers = r.fields()
        val body = if (r.done()) ByteArray(0) else r.bytes()
        return BhttpResponse(status.toInt(), headers, body)
    }
}
