package com.flagshipserver.app.core.pq

import org.bouncycastle.crypto.digests.SHA3Digest
import org.bouncycastle.crypto.digests.SHA512Digest
import org.bouncycastle.crypto.digests.SHAKEDigest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.kems.MLKEMExtractor
import org.bouncycastle.crypto.kems.MLKEMGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.MLDSAParameters
import org.bouncycastle.crypto.params.MLDSAPrivateKeyParameters
import org.bouncycastle.crypto.params.MLDSAPublicKeyParameters
import org.bouncycastle.crypto.params.MLKEMParameters
import org.bouncycastle.crypto.params.MLKEMPrivateKeyParameters
import org.bouncycastle.crypto.params.MLKEMPublicKeyParameters
import org.bouncycastle.crypto.params.ParametersWithContext
import org.bouncycastle.crypto.params.ParametersWithRandom
import org.bouncycastle.crypto.signers.MLDSASigner
import org.bouncycastle.math.ec.rfc7748.X25519
import org.bouncycastle.math.ec.rfc8032.Ed25519
import java.nio.charset.CodingErrorAction
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Architecture v2 hybrid suites, the Kotlin twin of packages/protocol/src/pqHybrid.ts (and the
 * Rust `flagship-crypto`). DRAFT, pending Q01 external cryptographic review.
 * Spec: docs/architecture-v2/pq-suites.md. Vectors: packages/protocol/test-vectors/pq-hybrid/.
 * Names, refusal codes and check order match the TypeScript port.
 */
class PqHybridException(val code: String) : Exception(code)

object PqHybrid {
    const val SUITE_HYBRID_SEAL_V1 = 0x0001
    const val SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 = 0x0002
    const val TAG_HYBRID_SEAL_V1 = "flagship/hybrid-seal/v1"
    const val TAG_HYBRID_SIG_ED25519_MLDSA65_V1 = "flagship/hybrid-sig/ed25519-mldsa65/v1"
    const val TAG_ENVELOPE_V2 = "flagship/envelope/v2"
    private const val TAG_KEY_ID = "flagship/pq-key-id/v1"

    const val ENVELOPE_MAX_HEADER_LEN = 1024
    const val ENVELOPE_MAX_BODY_LEN = 1_048_576 + 4096
    const val HYBRID_SEAL_PUBLIC_KEY_LEN = 1216
    const val HYBRID_SEAL_SECRET_KEY_LEN = 32
    const val HYBRID_SEAL_ENC_LEN = 1120
    const val HYBRID_SEAL_TAG_LEN = 16
    const val HYBRID_SEAL_RANDOMNESS_LEN = 64
    const val HYBRID_SEAL_MAX_PLAINTEXT_LEN = 1_048_576
    const val HYBRID_SEAL_MAX_CONTEXT_FIELDS = 16
    const val HYBRID_SEAL_MAX_CONTEXT_FIELD_LEN = 1024
    const val HYBRID_SIG_PUBLIC_KEY_LEN = 1984
    const val HYBRID_SIG_SECRET_KEY_LEN = 64
    const val HYBRID_SIG_LEN = 3373
    const val HYBRID_SIG_MAX_PAYLOAD_LEN = 1_048_576
    const val MLDSA65_PUBLIC_KEY_LEN = 1952
    const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    private const val KEY_ID_LEN = 32
    private const val ML_KEM_PK_LEN = 1184
    private const val ML_KEM_CT_LEN = 1088
    private const val ED_PK_LEN = 32
    private const val ED_SIG_LEN = 64
    private const val OKM_LEN = 44
    private val XWING_LABEL = byteArrayOf(0x5c, 0x2e, 0x2f, 0x2f, 0x5e, 0x5c)

    private val SUITE_TAGS = mapOf(
        SUITE_HYBRID_SEAL_V1 to TAG_HYBRID_SEAL_V1,
        SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 to TAG_HYBRID_SIG_ED25519_MLDSA65_V1,
    )

    private val rng = SecureRandom()

    private fun fail(code: String): Nothing = throw PqHybridException(code)

    internal fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    internal fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var o = 0
        for (p in parts) {
            System.arraycopy(p, 0, out, o, p.size)
            o += p.size
        }
        return out
    }

    internal fun equalBytes(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    private fun u8(n: Int) = byteArrayOf((n and 0xff).toByte())
    private fun u16be(n: Int) = byteArrayOf(((n ushr 8) and 0xff).toByte(), (n and 0xff).toByte())
    private fun u32be(n: Int) = ByteBuffer.allocate(4).putInt(n).array()
    private fun u64be(n: Long) = ByteBuffer.allocate(8).putLong(n).array()
    private fun lp8(b: ByteArray) = concat(u8(b.size), b)

    private val SEGMENT = Regex("^[a-z0-9][a-z0-9-]*$")
    private val VERSION = Regex("^v[1-9][0-9]{0,3}$")

    /** Purpose-tag grammar (§2.2); [allowLegacyPb] admits the v1 `pb/...` tags. */
    fun validatePurposeTag(tag: String, allowLegacyPb: Boolean = false): Boolean {
        if (tag.isEmpty() || tag.length > 128) return false
        val parts = tag.split("/")
        val ns = parts[0]
        if (!(ns == "flagship" || (allowLegacyPb && ns == "pb"))) return false
        val segments = parts.size - 2
        if (segments < 1 || segments > 6) return false
        for (seg in parts.subList(1, parts.size - 1)) {
            if (seg.isEmpty() || seg.length > 48 || !SEGMENT.matches(seg)) return false
        }
        return VERSION.matches(parts.last())
    }

    // ── v2 envelope header (§3) ──────────────────────────────────────────

    data class EnvelopeHeaderV2(
        val purpose: String,
        val suite: Int,
        val senderKeyId: ByteArray,
        val recipientKeyId: ByteArray? = null,
        val installationId: ByteArray? = null,
        val authorityGeneration: Long? = null,
        val sessionNonce: ByteArray? = null,
        val policyDigest: ByteArray? = null,
        val issuedAt: Long,
        val expiresAt: Long? = null,
        val bodyLen: Long,
    )

    private object T {
        const val PURPOSE = 0x01
        const val SUITE = 0x02
        const val SENDER = 0x03
        const val RECIPIENT = 0x04
        const val INSTALLATION = 0x05
        const val GENERATION = 0x06
        const val SESSION = 0x07
        const val POLICY = 0x08
        const val ISSUED = 0x09
        const val EXPIRES = 0x0a
        const val BODY_LEN = 0x0b
    }

    private val FIXED_LEN = mapOf(
        T.SUITE to 2, T.SENDER to 32, T.RECIPIENT to 32, T.INSTALLATION to 16, T.GENERATION to 8,
        T.SESSION to 32, T.POLICY to 64, T.ISSUED to 8, T.EXPIRES to 8, T.BODY_LEN to 4,
    )

    // A decoded u64 above 2^53-1 reads as -1, the TS port's NaN: refused by isUint.
    private fun isUint(n: Long?) = n != null && n in 0..MAX_SAFE_INTEGER

    private fun validateHeader(h: EnvelopeHeaderV2) {
        val p = utf8(h.purpose)
        if (p.isEmpty() || p.size > 128) fail("header-field-length")
        if (!validatePurposeTag(h.purpose)) fail("header-bad-value")
        val fixed = listOf(h.senderKeyId to 32, h.recipientKeyId to 32, h.installationId to 16, h.sessionNonce to 32, h.policyDigest to 64)
        for ((v, n) in fixed) if (v != null && v.size != n) fail("header-field-length")
        if (SUITE_TAGS[h.suite] == null) fail("header-bad-value")
        if (!isUint(h.issuedAt)) fail("header-bad-value")
        if (h.expiresAt != null && !isUint(h.expiresAt)) fail("header-bad-value")
        if (h.authorityGeneration != null && !isUint(h.authorityGeneration)) fail("header-bad-value")
        if (h.expiresAt != null && h.expiresAt <= h.issuedAt) fail("header-bad-value")
        if (h.bodyLen < 0 || h.bodyLen > ENVELOPE_MAX_BODY_LEN) fail("header-bad-value")
        if (h.suite == SUITE_HYBRID_SEAL_V1 && h.recipientKeyId == null) fail("header-missing-field")
    }

    fun encodeEnvelopeHeader(h: EnvelopeHeaderV2): ByteArray {
        validateHeader(h)
        val tlv = java.io.ByteArrayOutputStream()
        fun put(ty: Int, v: ByteArray) {
            tlv.write(u8(ty)); tlv.write(u16be(v.size)); tlv.write(v)
        }
        put(T.PURPOSE, utf8(h.purpose))
        put(T.SUITE, u16be(h.suite))
        put(T.SENDER, h.senderKeyId)
        h.recipientKeyId?.let { put(T.RECIPIENT, it) }
        h.installationId?.let { put(T.INSTALLATION, it) }
        h.authorityGeneration?.let { put(T.GENERATION, u64be(it)) }
        h.sessionNonce?.let { put(T.SESSION, it) }
        h.policyDigest?.let { put(T.POLICY, it) }
        put(T.ISSUED, u64be(h.issuedAt))
        h.expiresAt?.let { put(T.EXPIRES, u64be(it)) }
        put(T.BODY_LEN, u32be(h.bodyLen.toInt()))
        val body = tlv.toByteArray()
        val out = concat(lp8(utf8(TAG_ENVELOPE_V2)), u16be(body.size), body)
        if (out.size > ENVELOPE_MAX_HEADER_LEN) fail("header-too-large")
        return out
    }

    private fun readU64(v: ByteArray): Long {
        val n = ByteBuffer.wrap(v).long
        return if (n < 0 || n > MAX_SAFE_INTEGER) -1L else n
    }

    private fun strictUtf8(b: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(b)).toString()
    } catch (_: Exception) {
        null
    }

    data class DecodedHeader(val header: EnvelopeHeaderV2, val length: Int)

    /** Decodes a header at the start of [bytes]; check order as in §3.3. */
    fun decodeEnvelopeHeader(bytes: ByteArray): DecodedHeader {
        val magic = lp8(utf8(TAG_ENVELOPE_V2))
        if (bytes.size < magic.size) fail("header-truncated")
        if (!equalBytes(bytes.copyOfRange(0, magic.size), magic)) fail("header-bad-magic")
        if (bytes.size < magic.size + 2) fail("header-truncated")
        val tlvLen = ((bytes[magic.size].toInt() and 0xff) shl 8) or (bytes[magic.size + 1].toInt() and 0xff)
        val total = magic.size + 2 + tlvLen
        if (total > ENVELOPE_MAX_HEADER_LEN) fail("header-too-large")
        if (bytes.size < total) fail("header-truncated")
        val tlv = bytes.copyOfRange(magic.size + 2, total)

        val f = HashMap<Int, ByteArray>()
        var purpose: String? = null
        var prev = 0
        var o = 0
        while (o < tlv.size) {
            if (o + 3 > tlv.size) fail("header-truncated")
            val ty = tlv[o].toInt() and 0xff
            val len = ((tlv[o + 1].toInt() and 0xff) shl 8) or (tlv[o + 2].toInt() and 0xff)
            o += 3
            if (o + len > tlv.size) fail("header-truncated")
            val value = tlv.copyOfRange(o, o + len)
            o += len
            if (ty < T.PURPOSE || ty > T.BODY_LEN) fail("header-unknown-field")
            if (ty == prev) fail("header-duplicate-field")
            if (ty < prev) fail("header-field-order")
            prev = ty
            if (ty == T.PURPOSE) {
                if (len == 0 || len > 128) fail("header-field-length")
                purpose = strictUtf8(value) ?: fail("header-bad-value")
            } else if (len != FIXED_LEN[ty]) {
                fail("header-field-length")
            }
            if (ty == T.SUITE && SUITE_TAGS[((value[0].toInt() and 0xff) shl 8) or (value[1].toInt() and 0xff)] == null) fail("header-bad-value")
            f[ty] = value
        }
        fun req(ty: Int): ByteArray = f[ty] ?: fail("header-missing-field")
        val p = purpose ?: fail("header-missing-field")
        val suiteB = req(T.SUITE)
        val sender = req(T.SENDER)
        val issued = req(T.ISSUED)
        val bodyLenB = req(T.BODY_LEN)
        val header = EnvelopeHeaderV2(
            purpose = p,
            suite = ((suiteB[0].toInt() and 0xff) shl 8) or (suiteB[1].toInt() and 0xff),
            senderKeyId = sender,
            recipientKeyId = f[T.RECIPIENT],
            installationId = f[T.INSTALLATION],
            authorityGeneration = f[T.GENERATION]?.let(::readU64),
            sessionNonce = f[T.SESSION],
            policyDigest = f[T.POLICY],
            issuedAt = readU64(issued),
            expiresAt = f[T.EXPIRES]?.let(::readU64),
            bodyLen = ByteBuffer.wrap(bodyLenB).int.toLong() and 0xffffffffL,
        )
        validateHeader(header)
        if (!equalBytes(encodeEnvelopeHeader(header), bytes.copyOfRange(0, total))) fail("header-bad-value")
        return DecodedHeader(header, total)
    }

    data class DecodedEnvelope(val header: EnvelopeHeaderV2, val headerBytes: ByteArray, val body: ByteArray)

    /** Decodes `header || body`; the body must be exactly `bodyLen` bytes. */
    fun decodeEnvelope(bytes: ByteArray): DecodedEnvelope {
        val (header, length) = decodeEnvelopeHeader(bytes)
        val body = bytes.copyOfRange(length, bytes.size)
        if (body.size.toLong() != header.bodyLen) fail("body-length")
        return DecodedEnvelope(header, bytes.copyOfRange(0, length), body)
    }

    // ── Key ids (§2.3) ───────────────────────────────────────────────────

    fun pqKeyId(suite: Int, publicKey: ByteArray): ByteArray {
        val d = sha512(concat(lp8(utf8(TAG_KEY_ID)), u16be(suite), u16be(publicKey.size), publicKey))
        return d.copyOfRange(0, KEY_ID_LEN)
    }

    internal fun sha512(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-512").digest(b)

    // ── X-Wing (draft-connolly-cfrg-xwing-kem-11) ────────────────────────

    private fun shake256(input: ByteArray, outLen: Int): ByteArray {
        val d = SHAKEDigest(256)
        d.update(input, 0, input.size)
        val out = ByteArray(outLen)
        d.doFinal(out, 0, outLen)
        return out
    }

    private fun sha3256(input: ByteArray): ByteArray {
        val d = SHA3Digest(256)
        d.update(input, 0, input.size)
        val out = ByteArray(32)
        d.doFinal(out, 0)
        return out
    }

    private fun x25519(scalar: ByteArray, point: ByteArray): ByteArray? {
        val out = ByteArray(32)
        return if (X25519.calculateAgreement(scalar, 0, point, 0, out, 0)) out else null
    }

    private fun x25519Base(scalar: ByteArray): ByteArray = ByteArray(32).also { X25519.scalarMultBase(scalar, 0, it, 0) }

    private class XWingSecret(seed: ByteArray) {
        private val expanded = shake256(seed, 96)
        val mlkem = MLKEMPrivateKeyParameters(MLKEMParameters.ml_kem_768, expanded.copyOfRange(0, 64))
        val skX: ByteArray = expanded.copyOfRange(64, 96)
        val pkX: ByteArray = x25519Base(skX)
        val publicKey: ByteArray = concat(mlkem.publicKey, pkX)
        fun wipe() {
            expanded.fill(0); skX.fill(0); mlkem.destroy()
        }
    }

    private fun combiner(ssM: ByteArray, ssX: ByteArray, ctX: ByteArray, pkX: ByteArray) =
        sha3256(concat(ssM, ssX, ctX, pkX, XWING_LABEL))

    /** X-Wing KeyGen from a 32-byte seed: the 1216-byte public key. */
    fun xwingPublicKey(seed: ByteArray): ByteArray {
        val s = XWingSecret(seed)
        try {
            return s.publicKey
        } finally {
            s.wipe()
        }
    }

    /** X-Wing derandomized encapsulation: (enc, sharedSecret). [eseed] = ML-KEM coins || X25519 ephemeral. */
    fun xwingEncapsulate(publicKey: ByteArray, eseed: ByteArray): Pair<ByteArray, ByteArray> {
        val pkM = MLKEMPublicKeyParameters(MLKEMParameters.ml_kem_768, publicKey.copyOfRange(0, ML_KEM_PK_LEN))
        val pkX = publicKey.copyOfRange(ML_KEM_PK_LEN, HYBRID_SEAL_PUBLIC_KEY_LEN)
        val ekX = eseed.copyOfRange(32, 64)
        val ctX = x25519Base(ekX)
        val ssX = x25519(ekX, pkX) ?: run { ekX.fill(0); fail("bad-public-key") }
        ekX.fill(0)
        val m = MLKEMGenerator.internalGenerateEncapsulated(pkM, eseed.copyOfRange(0, 32))
        val ssM = m.secret
        val ctM = m.encapsulation
        val ss = combiner(ssM, ssX, ctX, pkX)
        ssM.fill(0); ssX.fill(0)
        return concat(ctM, ctX) to ss
    }

    /** X-Wing decapsulation; an all-zero X25519 shared secret is refused (as noble does). */
    fun xwingDecapsulate(enc: ByteArray, seed: ByteArray): ByteArray {
        val s = XWingSecret(seed)
        try {
            val ctM = enc.copyOfRange(0, ML_KEM_CT_LEN)
            val ctX = enc.copyOfRange(ML_KEM_CT_LEN, HYBRID_SEAL_ENC_LEN)
            val ssM = MLKEMExtractor(s.mlkem).extractSecret(ctM)
            val ssX = x25519(s.skX, ctX) ?: run { ssM.fill(0); fail("decrypt-failed") }
            val ss = combiner(ssM, ssX, ctX, s.pkX)
            ssM.fill(0); ssX.fill(0)
            return ss
        } finally {
            s.wipe()
        }
    }

    // ── flagship/hybrid-seal/v1 (§4) ─────────────────────────────────────

    private val X25519_PROBE = ByteArray(32) { 0x5a }

    // FIPS 203 §7.2 modulus check: every 12-bit coefficient of t̂ is below q.
    private fun mlKemModulusOk(ek: ByteArray): Boolean {
        var i = 0
        while (i < 1152) {
            val b0 = ek[i].toInt() and 0xff
            val b1 = ek[i + 1].toInt() and 0xff
            val b2 = ek[i + 2].toInt() and 0xff
            if ((b0 or ((b1 and 0x0f) shl 8)) >= 3329) return false
            if (((b1 shr 4) or (b2 shl 4)) >= 3329) return false
            i += 3
        }
        return true
    }

    /** Validates an X-Wing encapsulation key (length, ML-KEM modulus, X25519 not small order). */
    fun parseHybridSealPublicKey(pk: ByteArray): ByteArray {
        if (pk.size != HYBRID_SEAL_PUBLIC_KEY_LEN) fail("bad-public-key")
        if (!mlKemModulusOk(pk.copyOfRange(0, ML_KEM_PK_LEN))) fail("bad-public-key")
        if (x25519(X25519_PROBE, pk.copyOfRange(ML_KEM_PK_LEN, pk.size)) == null) fail("bad-public-key")
        return pk
    }

    data class KeyPair(val publicKey: ByteArray, val secretKey: ByteArray)

    fun hybridSealKeygen(seed: ByteArray): KeyPair {
        if (seed.size != HYBRID_SEAL_SECRET_KEY_LEN) fail("bad-secret-key")
        return KeyPair(parseHybridSealPublicKey(xwingPublicKey(seed)), seed.copyOf())
    }

    data class HybridSealOptions(
        val purpose: String,
        val senderKeyId: ByteArray,
        val issuedAt: Long,
        val expiresAt: Long? = null,
        val installationId: ByteArray? = null,
        val authorityGeneration: Long? = null,
        val sessionNonce: ByteArray? = null,
        val policyDigest: ByteArray? = null,
    )

    private fun checkSealInputs(purpose: String, context: List<ByteArray>) {
        if (!validatePurposeTag(purpose)) fail("bad-purpose")
        if (context.size > HYBRID_SEAL_MAX_CONTEXT_FIELDS || context.any { it.size > HYBRID_SEAL_MAX_CONTEXT_FIELD_LEN }) {
            fail("context-too-large")
        }
    }

    /** The HKDF `info` (§4.3). */
    fun hybridSealKdfInfo(headerBytes: ByteArray, header: EnvelopeHeaderV2, context: List<ByteArray>, enc: ByteArray): ByteArray {
        val ctx = mutableListOf(u8(context.size))
        for (c in context) {
            ctx += u16be(c.size); ctx += c
        }
        return concat(
            lp8(utf8(TAG_HYBRID_SEAL_V1)),
            u16be(SUITE_HYBRID_SEAL_V1),
            lp8(utf8(header.purpose)),
            header.senderKeyId,
            header.recipientKeyId ?: ByteArray(KEY_ID_LEN),
            u32be(headerBytes.size),
            headerBytes,
            *ctx.toTypedArray(),
            enc,
        )
    }

    private fun deriveSealKeys(ss: ByteArray, info: ByteArray): Pair<ByteArray, ByteArray> {
        val gen = HKDFBytesGenerator(SHA512Digest())
        gen.init(HKDFParameters(ss, utf8(TAG_HYBRID_SEAL_V1), info))
        val okm = ByteArray(OKM_LEN)
        gen.generateBytes(okm, 0, OKM_LEN)
        val out = okm.copyOfRange(0, 32) to okm.copyOfRange(32, OKM_LEN)
        okm.fill(0)
        return out
    }

    private fun gcm(mode: Int, key: ByteArray, nonce: ByteArray, aad: ByteArray, input: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        return c.doFinal(input)
    }

    /**
     * Seal with caller-supplied encapsulation randomness (ML-KEM coins, then the X25519
     * ephemeral secret). For vectors only: reusing [eseed] reuses the AES key and nonce.
     */
    fun hybridSealWithRandomness(
        recipientPublicKey: ByteArray,
        opts: HybridSealOptions,
        context: List<ByteArray>,
        plaintext: ByteArray,
        eseed: ByteArray,
    ): ByteArray {
        val pk = parseHybridSealPublicKey(recipientPublicKey)
        checkSealInputs(opts.purpose, context)
        if (plaintext.size > HYBRID_SEAL_MAX_PLAINTEXT_LEN) fail("plaintext-too-large")
        if (eseed.size != HYBRID_SEAL_RANDOMNESS_LEN) fail("randomness")
        val header = EnvelopeHeaderV2(
            purpose = opts.purpose,
            suite = SUITE_HYBRID_SEAL_V1,
            senderKeyId = opts.senderKeyId,
            recipientKeyId = pqKeyId(SUITE_HYBRID_SEAL_V1, pk),
            installationId = opts.installationId,
            authorityGeneration = opts.authorityGeneration,
            sessionNonce = opts.sessionNonce,
            policyDigest = opts.policyDigest,
            issuedAt = opts.issuedAt,
            expiresAt = opts.expiresAt,
            bodyLen = (HYBRID_SEAL_ENC_LEN + plaintext.size + HYBRID_SEAL_TAG_LEN).toLong(),
        )
        val headerBytes = encodeEnvelopeHeader(header)
        val (enc, ss) = xwingEncapsulate(pk, eseed)
        val (key, nonce) = deriveSealKeys(ss, hybridSealKdfInfo(headerBytes, header, context, enc))
        ss.fill(0)
        try {
            val sealed = gcm(Cipher.ENCRYPT_MODE, key, nonce, concat(headerBytes, enc), plaintext)
            return concat(headerBytes, enc, sealed)
        } finally {
            key.fill(0)
        }
    }

    fun hybridSeal(recipientPublicKey: ByteArray, opts: HybridSealOptions, context: List<ByteArray>, plaintext: ByteArray): ByteArray {
        val eseed = ByteArray(HYBRID_SEAL_RANDOMNESS_LEN).also(rng::nextBytes)
        try {
            return hybridSealWithRandomness(recipientPublicKey, opts, context, plaintext, eseed)
        } finally {
            eseed.fill(0)
        }
    }

    data class Opened(val header: EnvelopeHeaderV2, val plaintext: ByteArray)

    /** Opens a seal; every failure past the header checks is `decrypt-failed`. */
    fun hybridOpen(recipientSecretKey: ByteArray, expectedPurpose: String, context: List<ByteArray>, sealed: ByteArray): Opened {
        checkSealInputs(expectedPurpose, context)
        val (publicKey) = hybridSealKeygen(recipientSecretKey)
        val (header, headerBytes, body) = decodeEnvelope(sealed)
        if (header.suite != SUITE_HYBRID_SEAL_V1) fail("suite-mismatch")
        if (header.purpose != expectedPurpose) fail("purpose-mismatch")
        val myId = pqKeyId(SUITE_HYBRID_SEAL_V1, publicKey)
        if (header.recipientKeyId == null || !equalBytes(header.recipientKeyId, myId)) fail("recipient-mismatch")
        if (body.size < HYBRID_SEAL_ENC_LEN + HYBRID_SEAL_TAG_LEN) fail("body-length")
        if (body.size - HYBRID_SEAL_ENC_LEN - HYBRID_SEAL_TAG_LEN > HYBRID_SEAL_MAX_PLAINTEXT_LEN) fail("plaintext-too-large")
        val enc = body.copyOfRange(0, HYBRID_SEAL_ENC_LEN)
        val ss = try {
            xwingDecapsulate(enc, recipientSecretKey)
        } catch (_: Exception) {
            fail("decrypt-failed")
        }
        val (key, nonce) = deriveSealKeys(ss, hybridSealKdfInfo(headerBytes, header, context, enc))
        ss.fill(0)
        try {
            val pt = gcm(Cipher.DECRYPT_MODE, key, nonce, concat(headerBytes, enc), body.copyOfRange(HYBRID_SEAL_ENC_LEN, body.size))
            return Opened(header, pt)
        } catch (_: Exception) {
            fail("decrypt-failed")
        } finally {
            key.fill(0)
        }
    }

    // ── flagship/hybrid-sig/ed25519-mldsa65/v1 (§5) ──────────────────────

    // Strict profile shared with ed25519-dalek's verify_strict and the TS port: canonical,
    // torsion-free, non-identity points. Bouncy Castle's full validation checks exactly that.
    internal fun strictPoint(b: ByteArray): Boolean =
        b.size == ED_PK_LEN && try {
            Ed25519.validatePublicKeyFull(b, 0)
        } catch (_: Exception) {
            false
        }

    /** Strict-profile Ed25519 (§5.3): the key and R canonical, torsion-free, not the identity. */
    fun ed25519VerifyStrict(sig: ByteArray, msg: ByteArray, pk: ByteArray): Boolean =
        sig.size == ED_SIG_LEN && pk.size == ED_PK_LEN && strictPoint(pk) && edVerifyStrict(sig, msg, pk)

    private fun edVerifyStrict(sig: ByteArray, msg: ByteArray, pk: ByteArray): Boolean {
        if (!strictPoint(sig.copyOfRange(0, 32))) return false
        return try {
            Ed25519.verify(sig, 0, pk, 0, msg, 0, msg.size)
        } catch (_: Exception) {
            false
        }
    }

    fun ed25519PublicKey(seed: ByteArray): ByteArray = ByteArray(32).also { Ed25519.generatePublicKey(seed, 0, it, 0) }

    fun ed25519Sign(seed: ByteArray, msg: ByteArray): ByteArray =
        ByteArray(ED_SIG_LEN).also { Ed25519.sign(seed, 0, msg, 0, msg.size, it, 0) }

    fun parseHybridSigPublicKey(pk: ByteArray): ByteArray {
        if (pk.size != HYBRID_SIG_PUBLIC_KEY_LEN) fail("bad-public-key")
        if (!strictPoint(pk.copyOfRange(0, ED_PK_LEN))) fail("bad-public-key")
        return pk
    }

    // Bouncy Castle keeps the seed array it is given and zeroes it on destroy(): always pass a copy.

    /** The ML-DSA-65 public key for a 32-byte KeyGen_internal seed ξ. */
    fun mldsa65PublicKey(seed: ByteArray): ByteArray {
        val sk = MLDSAPrivateKeyParameters(MLDSAParameters.ml_dsa_65, seed.copyOf())
        try {
            return sk.publicKey
        } finally {
            sk.destroy()
        }
    }

    /** ML-DSA-65 over [msg] with the given context; [deterministic] uses rnd = 0^32. */
    fun mldsa65Sign(seed: ByteArray, msg: ByteArray, context: ByteArray, deterministic: Boolean = false): ByteArray {
        val sk = MLDSAPrivateKeyParameters(MLDSAParameters.ml_dsa_65, seed.copyOf())
        try {
            val s = MLDSASigner()
            val base = if (deterministic) sk else ParametersWithRandom(sk, rng)
            s.init(true, ParametersWithContext(base, context))
            s.update(msg, 0, msg.size)
            return s.generateSignature()
        } finally {
            sk.destroy()
        }
    }

    fun mldsa65Verify(publicKey: ByteArray, msg: ByteArray, sig: ByteArray, context: ByteArray): Boolean = try {
        val s = MLDSASigner()
        s.init(false, ParametersWithContext(MLDSAPublicKeyParameters(MLDSAParameters.ml_dsa_65, publicKey), context))
        s.update(msg, 0, msg.size)
        s.verifySignature(sig)
    } catch (_: Exception) {
        false
    }

    /** Secret key = Ed25519 seed (32) || ML-DSA-65 KeyGen_internal seed (32), independent. */
    fun hybridSigKeygen(edSeed: ByteArray, mldsaSeed: ByteArray): KeyPair {
        if (edSeed.size != 32 || mldsaSeed.size != 32) fail("bad-secret-key")
        val publicKey = concat(ed25519PublicKey(edSeed), mldsa65PublicKey(mldsaSeed))
        try {
            parseHybridSigPublicKey(publicKey)
        } catch (_: PqHybridException) {
            fail("bad-secret-key")
        }
        return KeyPair(publicKey, concat(edSeed, mldsaSeed))
    }

    /** The signed message representative M' (§5.2). */
    fun hybridSigMessage(publicKey: ByteArray, purpose: String, payload: ByteArray): ByteArray {
        if (!validatePurposeTag(purpose)) fail("bad-purpose")
        if (payload.size > HYBRID_SIG_MAX_PAYLOAD_LEN) fail("payload-too-large")
        return concat(
            lp8(utf8(TAG_HYBRID_SIG_ED25519_MLDSA65_V1)),
            u16be(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1),
            publicKey,
            lp8(utf8(purpose)),
            u32be(payload.size),
            payload,
        )
    }

    /** Signs with both halves held in memory; [deterministic] uses ML-DSA's rnd = 0^32 variant. */
    fun hybridSign(secretKey: ByteArray, purpose: String, payload: ByteArray, deterministic: Boolean = false): ByteArray {
        if (secretKey.size != HYBRID_SIG_SECRET_KEY_LEN) fail("bad-secret-key")
        val edSeed = secretKey.copyOfRange(0, 32)
        val mlSeed = secretKey.copyOfRange(32, 64)
        try {
            val (publicKey) = hybridSigKeygen(edSeed, mlSeed)
            val m = hybridSigMessage(publicKey, purpose, payload)
            val mlSig = mldsa65Sign(mlSeed, m, utf8(TAG_HYBRID_SIG_ED25519_MLDSA65_V1), deterministic)
            return concat(ed25519Sign(edSeed, m), mlSig)
        } finally {
            edSeed.fill(0); mlSeed.fill(0)
        }
    }

    /**
     * Signs with the two halves held apart: [edSign] signs M' with the identity's existing
     * Ed25519 key wherever it lives; the ML-DSA seed is used here and not kept.
     */
    fun hybridSignSplit(
        ed25519Pub: ByteArray,
        edSign: (ByteArray) -> ByteArray,
        mldsaSeed: ByteArray,
        purpose: String,
        payload: ByteArray,
    ): ByteArray {
        val publicKey = parseHybridSigPublicKey(concat(ed25519Pub, mldsa65PublicKey(mldsaSeed)))
        val m = hybridSigMessage(publicKey, purpose, payload)
        val edSig = edSign(m)
        if (edSig.size != ED_SIG_LEN) fail("bad-signature")
        return concat(edSig, mldsa65Sign(mldsaSeed, m, utf8(TAG_HYBRID_SIG_ED25519_MLDSA65_V1)))
    }

    /** Throws unless BOTH components verify over M'. */
    fun hybridVerify(publicKey: ByteArray, purpose: String, payload: ByteArray, signature: ByteArray) {
        parseHybridSigPublicKey(publicKey)
        val m = hybridSigMessage(publicKey, purpose, payload)
        if (signature.size != HYBRID_SIG_LEN) fail("bad-signature")
        val edOk = edVerifyStrict(signature.copyOfRange(0, ED_SIG_LEN), m, publicKey.copyOfRange(0, ED_PK_LEN))
        val mlOk = mldsa65Verify(
            publicKey.copyOfRange(ED_PK_LEN, publicKey.size), m,
            signature.copyOfRange(ED_SIG_LEN, signature.size), utf8(TAG_HYBRID_SIG_ED25519_MLDSA65_V1),
        )
        if (!(edOk && mlOk)) fail("bad-signature")
    }
}
