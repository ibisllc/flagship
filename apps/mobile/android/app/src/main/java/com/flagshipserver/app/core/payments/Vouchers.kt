// The $1 voucher: the Kotlin twin of packages/protocol/src/voucher.ts (RFC 9474 RSABSSA-SHA384-PSS-Randomized), tested
// against packages/protocol/test-vectors/vouchers/. The device makes a random nonce, blinds it, `.com` signs blind, the
// device unblinds; at redemption `.com` checks its own signature but can't tell which signing produced it.
//
//   keyId     first 16 hex of SHA-256("flagship/voucher-key/v1|" + nHex + "|" + eHex)
//   message   "flagship/voucher/v1|" followed by the 32-byte nonce
//   prepared  32-byte prefix followed by the message
//   voucher   {k, p (hex prefix), n (hex nonce), s (standard base64 PSS signature over prepared)}
//   nullifier SHA-256 hex of "flagship/voucher-nullifier/v1|" + k + "|" + n

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.WebEnvelopes
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom

data class Voucher(val k: String, val p: String, val n: String, val s: String) {
    fun toJson() = JsonObject(linkedMapOf("k" to JsonPrimitive(k), "p" to JsonPrimitive(p), "n" to JsonPrimitive(n), "s" to JsonPrimitive(s)))
    val nullifier: String get() = Vouchers.nullifier(k, n)
}

data class VoucherKey(val keyId: String, val nHex: String, val eHex: String)

/** A blinded request kept until the signature comes back. [inv] is secret: with it the signer could link the two. */
data class PendingVoucher(val k: String, val p: String, val n: String, val inv: String)

object Vouchers {
    const val TAG = "flagship/voucher/v1"
    const val TAG_KEY = "flagship/voucher-key/v1"
    const val TAG_NULLIFIER = "flagship/voucher-nullifier/v1"
    const val MIN_MODULUS_BITS = 2048
    private const val H_LEN = 48
    private const val S_LEN = 48
    private val KEY_ID = Regex("^[0-9a-f]{16}$")
    private val rng = SecureRandom()

    private fun sha384(vararg parts: ByteArray): ByteArray = MessageDigest.getInstance("SHA-384").run { parts.forEach { update(it) }; digest() }
    private fun utf8(s: String) = s.toByteArray(Charsets.UTF_8)

    fun keyId(nHex: String, eHex: String): String = VoiciJs.hex(VoiciJs.sha256(utf8("$TAG_KEY|$nHex|$eHex"))).substring(0, 16)

    fun nullifier(k: String, n: String): String = VoiciJs.hex(VoiciJs.sha256(utf8("$TAG_NULLIFIER|$k|$n")))

    class Rsa(val n: BigInteger, val e: BigInteger) {
        val kLen: Int get() = (n.bitLength() + 7) / 8
    }

    /** The RSA key of a served key, or null when its id doesn't match its numbers or it is too small. */
    fun rsa(k: VoucherKey): Rsa? {
        if (!KEY_ID.matches(k.keyId) || !WebEnvelopes.isLowerHex(k.nHex) || !WebEnvelopes.isLowerHex(k.eHex) || k.eHex.isEmpty()) return null
        if (keyId(k.nHex, k.eHex) != k.keyId) return null
        val n = BigInteger(k.nHex, 16)
        val e = BigInteger(k.eHex, 16)
        val r = Rsa(n, e)
        if (n.bitLength() < MIN_MODULUS_BITS || k.nHex.length != r.kLen * 2) return null
        if (e < BigInteger.valueOf(3) || !e.testBit(0)) return null
        return r
    }

    fun message(nonce: ByteArray): ByteArray {
        require(nonce.size == 32) { "$TAG: nonce must be 32 bytes" }
        return utf8("$TAG|") + nonce
    }

    fun prepared(p: String, n: String): ByteArray = WebEnvelopes.hexToBytes(p) + message(WebEnvelopes.hexToBytes(n))

    /** Strict shape of an untrusted voucher (no signature check). */
    fun parse(v: JsonElement?): Voucher? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("k", "p", "n", "s"))) return null
        val k = VoiciJs.str(o["k"])?.takeIf { KEY_ID.matches(it) } ?: return null
        val p = VoiciJs.str(o["p"])?.takeIf { WebEnvelopes.isLowerHex(it, 32) } ?: return null
        val n = VoiciJs.str(o["n"])?.takeIf { WebEnvelopes.isLowerHex(it, 32) } ?: return null
        val s = VoiciJs.str(o["s"])?.takeIf { WebEnvelopes.b64Decode(it) != null } ?: return null
        return Voucher(k, p, n, s)
    }

    internal fun i2osp(x: BigInteger, len: Int): ByteArray {
        val raw = x.toByteArray().let { if (it.size > 1 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }
        if (x.signum() == 0) return ByteArray(len)
        require(raw.size <= len) { "integer too large" }
        return ByteArray(len - raw.size) + raw
    }

    private fun os2ip(b: ByteArray) = BigInteger(1, b)

    private fun mgf1(seed: ByteArray, len: Int): ByteArray {
        val out = ByteArray(len)
        var off = 0
        var c = 0
        while (off < len) {
            val h = sha384(seed, byteArrayOf((c ushr 24).toByte(), (c ushr 16).toByte(), (c ushr 8).toByte(), c.toByte()))
            System.arraycopy(h, 0, out, off, minOf(h.size, len - off))
            off += h.size
            c++
        }
        return out
    }

    private fun emsaPssEncode(msg: ByteArray, emBits: Int, salt: ByteArray): ByteArray {
        val emLen = (emBits + 7) / 8
        require(emLen >= H_LEN + S_LEN + 2) { "modulus too small" }
        val h = sha384(ByteArray(8), sha384(msg), salt)
        val db = ByteArray(emLen - H_LEN - 1)
        db[emLen - S_LEN - H_LEN - 2] = 1
        System.arraycopy(salt, 0, db, emLen - S_LEN - H_LEN - 1, S_LEN)
        val mask = mgf1(h, db.size)
        for (i in db.indices) db[i] = (db[i].toInt() xor mask[i].toInt()).toByte()
        db[0] = (db[0].toInt() and (0xff ushr (8 * emLen - emBits))).toByte()
        return db + h + byteArrayOf(0xbc.toByte())
    }

    private fun emsaPssVerify(msg: ByteArray, em: ByteArray, emBits: Int): Boolean {
        val emLen = (emBits + 7) / 8
        if (em.size != emLen || emLen < H_LEN + S_LEN + 2 || em[emLen - 1] != 0xbc.toByte()) return false
        val maskedDb = em.copyOfRange(0, emLen - H_LEN - 1)
        val h = em.copyOfRange(emLen - H_LEN - 1, emLen - 1)
        val topMask = 0xff ushr (8 * emLen - emBits)
        if ((maskedDb[0].toInt() and topMask.inv() and 0xff) != 0) return false
        val mask = mgf1(h, maskedDb.size)
        val db = ByteArray(maskedDb.size) { (maskedDb[it].toInt() xor mask[it].toInt()).toByte() }
        db[0] = (db[0].toInt() and topMask).toByte()
        val psLen = emLen - H_LEN - S_LEN - 2
        for (i in 0 until psLen) if (db[i] != 0.toByte()) return false
        if (db[psLen] != 1.toByte()) return false
        val salt = db.copyOfRange(db.size - S_LEN, db.size)
        return MessageDigest.isEqual(sha384(ByteArray(8), sha384(msg), salt), h)
    }

    /** RSASSA-PSS-VERIFY (SHA-384, MGF1-SHA-384, 48-byte salt). */
    fun pssVerify(pk: Rsa, msg: ByteArray, sig: ByteArray): Boolean {
        if (sig.size != pk.kLen) return false
        val s = os2ip(sig)
        if (s >= pk.n) return false
        val emBits = pk.n.bitLength() - 1
        val em = runCatching { i2osp(s.modPow(pk.e, pk.n), (emBits + 7) / 8) }.getOrNull() ?: return false
        return emsaPssVerify(msg, em, emBits)
    }

    private fun random(n: Int) = ByteArray(n).also(rng::nextBytes)

    /** One request under [key]; send `blinded` (standard base64) to the issuer, keep `pending`. The optionals are for vectors. */
    fun request(key: VoucherKey, nonce: ByteArray? = null, prefix: ByteArray? = null, salt: ByteArray? = null, r: BigInteger? = null): Pair<PendingVoucher, String> {
        val pk = rsa(key) ?: throw IllegalArgumentException("$TAG: bad key")
        val nn = nonce ?: random(32)
        val pp = prefix ?: random(32)
        require(pp.size == 32) { "prefix must be 32 bytes" }
        val prep = pp + message(nn)
        val em = emsaPssEncode(prep, pk.n.bitLength() - 1, salt ?: random(S_LEN))
        val m = os2ip(em)
        require(m.gcd(pk.n) == BigInteger.ONE) { "invalid input" }
        var rr = r
        if (rr == null) {
            do {
                rr = os2ip(random(pk.kLen)).mod(pk.n)
            } while (rr!! < BigInteger.valueOf(2) || rr.gcd(pk.n) != BigInteger.ONE)
        }
        val inv = rr.modInverse(pk.n)
        val z = m.multiply(rr.modPow(pk.e, pk.n)).mod(pk.n)
        val invHex = inv.toString(16).let { if (it.length % 2 == 1) "0$it" else it }
        return PendingVoucher(key.keyId, VoiciJs.hex(pp), VoiciJs.hex(nn), invHex) to WebEnvelopes.b64Encode(i2osp(z, pk.kLen))
    }

    /** Unblind the issuer's answer; throws when the signature doesn't verify. */
    fun finalize(key: VoucherKey, pending: PendingVoucher, blindSig: String): Voucher {
        val pk = rsa(key) ?: throw IllegalArgumentException("$TAG: bad key")
        require(pending.k == key.keyId) { "$TAG: bad key" }
        val bs = WebEnvelopes.b64Decode(blindSig) ?: throw IllegalArgumentException("$TAG: bad blind signature")
        require(bs.size == pk.kLen) { "blind signature has the wrong length" }
        val s = os2ip(bs).multiply(BigInteger(pending.inv, 16)).mod(pk.n)
        val sig = i2osp(s, pk.kLen)
        require(pssVerify(pk, prepared(pending.p, pending.n), sig)) { "the signer's blind signature doesn't verify" }
        return Voucher(pending.k, pending.p, pending.n, WebEnvelopes.b64Encode(sig))
    }

    fun verify(key: VoucherKey, v: Voucher): Boolean {
        val pk = rsa(key) ?: return false
        if (v.k != key.keyId || !WebEnvelopes.isLowerHex(v.p, 32) || !WebEnvelopes.isLowerHex(v.n, 32)) return false
        val sig = WebEnvelopes.b64Decode(v.s) ?: return false
        return pssVerify(pk, prepared(v.p, v.n), sig)
    }
}
