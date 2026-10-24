package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.bouncycastle.crypto.digests.SHA512Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class PqSessionException(val code: String) : Exception(code)

/**
 * `flagship/pq-session/v1`, the Kotlin twin of packages/protocol/src/pqSession.ts. DRAFT, pending
 * Q01 external cryptographic review. Spec: docs/architecture-v2/pq-suites.md §13. Vectors:
 * test-vectors/pq-session/.
 *
 * A PQ-authenticated channel to a box inside the TLS connection: an ephemeral X-Wing key from
 * this device, the box's encapsulation, and hybrid signatures by both sides under keys already
 * pinned through `flagship/pq-key-binding/v1`.
 */
object PqSession {
    const val TAG_SESSION = "flagship/pq-session/v1"
    const val TAG_HELLO = "flagship/pq-session-hello/v1"
    const val TAG_ACCEPT = "flagship/pq-session-accept/v1"
    const val TAG_FINISH = "flagship/pq-session-finish/v1"
    const val TAG_KEYS = "flagship/pq-session-keys/v1"
    const val TAG_RECORD = "flagship/pq-session-record/v1"
    const val MAX_SKEW_MS = 5L * 60 * 1000
    const val MAX_RECORD = 16 * 1024 * 1024
    const val IDLE_MS = 15L * 60 * 1000
    const val MAX_LIFETIME_MS = 12L * 3600 * 1000
    const val DIR_INITIATOR = 1
    const val DIR_RESPONDER = 2
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    fun interface Signer {
        fun sign(purpose: String, payload: ByteArray): ByteArray
    }

    private fun fail(code: String): Nothing = throw PqSessionException(code)
    private val SUBJECT = Regex("^[a-z0-9][a-z0-9.:@-]{0,252}$")
    private val rng = SecureRandom()

    private fun utf8(s: String) = s.toByteArray(Charsets.UTF_8)
    private fun lp8(s: String): ByteArray {
        val b = utf8(s)
        if (b.size > 255) fail("session-malformed")
        return byteArrayOf(b.size.toByte()) + b
    }
    private fun u64be(n: Long) = ByteBuffer.allocate(8).putLong(n).array()
    private fun sha512(b: ByteArray) = MessageDigest.getInstance("SHA-512").digest(b)
    private fun random(n: Int) = ByteArray(n).also { rng.nextBytes(it) }

    private fun exact(w: JsonElement?, keys: List<String>): JsonObject {
        val o = w as? JsonObject ?: fail("session-malformed")
        if (o.keys.sorted() != keys.sorted()) fail("session-malformed")
        val v = o["v"] as? JsonPrimitive
        if (v == null || v.isString || v.content != "1") fail("session-malformed")
        return o
    }

    private fun str(o: JsonObject, k: String): String {
        val p = o[k] as? JsonPrimitive ?: fail("session-malformed")
        if (!p.isString) fail("session-malformed")
        return p.content
    }

    private fun hexField(o: JsonObject, k: String, n: Int): ByteArray {
        val s = str(o, k)
        if (s.length != n * 2) fail("session-malformed")
        return PqHex.decode(s) ?: fail("session-malformed")
    }

    private fun timeField(o: JsonObject, k: String): Long {
        val p = o[k] as? JsonPrimitive ?: fail("session-malformed")
        if (p.isString) fail("session-malformed")
        val n = p.longOrNull ?: fail("session-malformed")
        if (n < 0 || n > MAX_SAFE_INTEGER) fail("session-malformed")
        return n
    }

    class Hello(
        val responder: String,
        val initiatorRole: String,
        val initiatorSubject: String,
        val initiatorKeyId: ByteArray,
        val responderKeyId: ByteArray,
        val ephemeralPub: ByteArray,
        val nonce: ByteArray,
        val issuedAt: Long,
    ) {
        fun bytes(): ByteArray = lp8(TAG_HELLO) + lp8(responder) + lp8(initiatorRole) + lp8(initiatorSubject) +
            initiatorKeyId + responderKeyId + ephemeralPub + nonce + u64be(issuedAt)

        fun toJson(): JsonObject = buildJsonObject {
            put("v", 1); put("responder", responder); put("initiatorRole", initiatorRole); put("initiatorSubject", initiatorSubject)
            put("initiatorKeyId", PqHex.encode(initiatorKeyId)); put("responderKeyId", PqHex.encode(responderKeyId))
            put("ephemeralPub", PqHex.encode(ephemeralPub)); put("nonce", PqHex.encode(nonce)); put("issuedAt", issuedAt)
        }

        companion object {
            fun parse(w: JsonElement?): Hello {
                val o = exact(w, listOf("ephemeralPub", "initiatorKeyId", "initiatorRole", "initiatorSubject", "issuedAt", "nonce", "responder", "responderKeyId", "v"))
                val r = str(o, "responder")
                val s = str(o, "initiatorSubject")
                val role = str(o, "initiatorRole")
                if (!SUBJECT.matches(r) || !SUBJECT.matches(s) || (role != "device" && role != "box-stk")) fail("session-malformed")
                return Hello(r, role, s, hexField(o, "initiatorKeyId", 32), hexField(o, "responderKeyId", 32),
                    hexField(o, "ephemeralPub", PqHybrid.HYBRID_SEAL_PUBLIC_KEY_LEN), hexField(o, "nonce", 32), timeField(o, "issuedAt"))
            }
        }
    }

    fun acceptTbs(helloBytes: ByteArray, enc: ByteArray, nonce: ByteArray, issuedAt: Long): ByteArray =
        lp8(TAG_ACCEPT) + sha512(helloBytes) + enc + nonce + u64be(issuedAt)

    internal class Prk(ss: ByteArray) {
        private val prk: ByteArray

        init {
            val g = HKDFBytesGenerator(SHA512Digest())
            prk = g.extractPRK(utf8(TAG_SESSION), ss)
        }

        fun expand(label: String, th: ByteArray): ByteArray {
            val g = HKDFBytesGenerator(SHA512Digest())
            g.init(HKDFParameters.skipExtractParameters(prk, lp8(TAG_KEYS) + lp8(label) + th))
            return ByteArray(32).also { g.generateBytes(it, 0, 32) }
        }

        fun confirm(label: String, th: ByteArray): ByteArray {
            val k = expand(label, th)
            try {
                val mac = Mac.getInstance("HmacSHA512")
                mac.init(SecretKeySpec(k, "HmacSHA512"))
                return mac.doFinal(th).copyOfRange(0, 32)
            } finally {
                k.fill(0)
            }
        }

        fun traffic(th4: ByteArray) = Keys(expand("session-id", th4), expand("initiator-to-responder", th4), expand("responder-to-initiator", th4))

        fun wipe() = prk.fill(0)
    }

    class Keys(val sessionId: ByteArray, val i2r: ByteArray, val r2i: ByteArray)

    /** The initiator between hello and accept. */
    class Initiator(
        responder: PqTrust.VerifiedBinding,
        initiatorRole: String,
        identity: PqTrust.VerifiedBinding,
        now: Long,
        ephemeralSeed: ByteArray? = null,
        nonce: ByteArray? = null,
    ) {
        val hello: Hello
        private val helloBytes: ByteArray
        private val responder: PqTrust.VerifiedBinding
        private var seed: ByteArray?

        init {
            if (responder.role != "box-stk" || !SUBJECT.matches(responder.subjectId)) fail("responder-mismatch")
            if (identity.role != initiatorRole || (initiatorRole != "device" && initiatorRole != "box-stk")) fail("unknown-initiator")
            val s = ephemeralSeed?.copyOf() ?: random(32)
            val n = nonce?.copyOf() ?: random(32)
            if (s.size != 32 || n.size != 32) fail("randomness")
            hello = Hello(responder.subjectId, initiatorRole, identity.subjectId, PqHex.decode(identity.keyIdHex)!!,
                PqHex.decode(responder.keyIdHex)!!, PqHybrid.xwingPublicKey(s), n, now)
            helloBytes = hello.bytes()
            this.responder = responder
            seed = s
        }

        /** Checks the box's accept and answers with the finish; single use. */
        fun finish(accept: JsonElement?, now: Long, sign: Signer): Pair<JsonObject, Channel> {
            val s = seed ?: fail("session-expired")
            seed = null
            try {
                val o = exact(accept, listOf("confirm", "enc", "issuedAt", "nonce", "signature", "v"))
                val enc = hexField(o, "enc", PqHybrid.HYBRID_SEAL_ENC_LEN)
                val nonce = hexField(o, "nonce", 32)
                val issuedAt = timeField(o, "issuedAt")
                val sigR = hexField(o, "signature", PqHybrid.HYBRID_SIG_LEN)
                val confirmR = hexField(o, "confirm", 32)
                if (kotlin.math.abs(issuedAt - now) > MAX_SKEW_MS) fail("session-stale")
                val tbsA = acceptTbs(helloBytes, enc, nonce, issuedAt)
                try {
                    PqHybrid.hybridVerify(responder.hybridPublicKey, TAG_ACCEPT, tbsA, sigR)
                } catch (_: PqHybridException) {
                    fail("bad-signature")
                }
                val ss = try {
                    PqHybrid.xwingDecapsulate(enc, s)
                } catch (_: Exception) {
                    fail("confirm-failed")
                }
                val prk = Prk(ss)
                ss.fill(0)
                try {
                    if (!MessageDigest.isEqual(prk.confirm("responder-confirm", sha512(tbsA + sigR)), confirmR)) fail("confirm-failed")
                    val tbsF = lp8(TAG_FINISH) + sha512(tbsA + sigR + confirmR)
                    val sigI = sign.sign(TAG_FINISH, tbsF)
                    if (sigI.size != PqHybrid.HYBRID_SIG_LEN) fail("bad-signature")
                    val confirmI = prk.confirm("initiator-confirm", sha512(tbsF + sigI))
                    val keys = prk.traffic(sha512(tbsF + sigI + confirmI))
                    val fin = buildJsonObject { put("v", 1); put("signature", PqHex.encode(sigI)); put("confirm", PqHex.encode(confirmI)) }
                    return fin to Channel(Side.INITIATOR, keys, now, responder)
                } finally {
                    prk.wipe()
                }
            } finally {
                s.fill(0)
            }
        }
    }

    /** The responder's half; boxes run the TypeScript port, this exists for the shared vectors. */
    class Pending internal constructor(private val initiator: PqTrust.VerifiedBinding, private val createdAt: Long, private val tbsF: ByteArray, private var prk: Prk?) {
        fun complete(finish: JsonElement?, now: Long): Channel {
            val p = prk ?: fail("session-expired")
            prk = null
            try {
                if (kotlin.math.abs(now - createdAt) > MAX_SKEW_MS) fail("session-stale")
                val o = exact(finish, listOf("confirm", "signature", "v"))
                val sigI = hexField(o, "signature", PqHybrid.HYBRID_SIG_LEN)
                val confirmI = hexField(o, "confirm", 32)
                try {
                    PqHybrid.hybridVerify(initiator.hybridPublicKey, TAG_FINISH, tbsF, sigI)
                } catch (_: PqHybridException) {
                    fail("bad-signature")
                }
                if (!MessageDigest.isEqual(p.confirm("initiator-confirm", sha512(tbsF + sigI)), confirmI)) fail("confirm-failed")
                return Channel(Side.RESPONDER, p.traffic(sha512(tbsF + sigI + confirmI)), now, initiator)
            } finally {
                p.wipe()
            }
        }
    }

    fun accept(
        hello: JsonElement?,
        identity: PqTrust.VerifiedBinding,
        lookup: (role: String, subject: String, keyIdHex: String) -> PqTrust.VerifiedBinding?,
        now: Long,
        sign: Signer,
        encapsulation: ByteArray? = null,
        nonce: ByteArray? = null,
    ): Pair<JsonObject, Pending> {
        val h = Hello.parse(hello)
        if (identity.role != "box-stk" || h.responder != identity.subjectId || PqHex.encode(h.responderKeyId) != identity.keyIdHex) fail("responder-mismatch")
        if (kotlin.math.abs(h.issuedAt - now) > MAX_SKEW_MS) fail("session-stale")
        val kid = PqHex.encode(h.initiatorKeyId)
        val ini = lookup(h.initiatorRole, h.initiatorSubject, kid)
        if (ini == null || ini.role != h.initiatorRole || ini.subjectId != h.initiatorSubject || ini.keyIdHex != kid) fail("unknown-initiator")
        try {
            PqHybrid.parseHybridSealPublicKey(h.ephemeralPub)
        } catch (_: PqHybridException) {
            fail("bad-public-key")
        }
        val eseed = encapsulation?.copyOf() ?: random(64)
        val (enc, ss) = try {
            PqHybrid.xwingEncapsulate(h.ephemeralPub, eseed)
        } catch (_: PqHybridException) {
            fail("bad-public-key")
        } finally {
            eseed.fill(0)
        }
        val prk = Prk(ss)
        ss.fill(0)
        val n = nonce?.copyOf() ?: random(32)
        val tbsA = acceptTbs(h.bytes(), enc, n, now)
        val sigR = sign.sign(TAG_ACCEPT, tbsA)
        if (sigR.size != PqHybrid.HYBRID_SIG_LEN) fail("bad-signature")
        val confirmR = prk.confirm("responder-confirm", sha512(tbsA + sigR))
        val tbsF = lp8(TAG_FINISH) + sha512(tbsA + sigR + confirmR)
        val acc = buildJsonObject {
            put("v", 1); put("enc", PqHex.encode(enc)); put("nonce", PqHex.encode(n)); put("issuedAt", now)
            put("signature", PqHex.encode(sigR)); put("confirm", PqHex.encode(confirmR))
        }
        return acc to Pending(ini, now, tbsF, prk)
    }

    private fun recordNonce(dir: Int, seq: Long) = byteArrayOf(0, 0, 0, dir.toByte()) + u64be(seq)
    private fun recordAad(sid: ByteArray, dir: Int, seq: Long) = lp8(TAG_RECORD) + sid + byteArrayOf(dir.toByte()) + u64be(seq)

    fun sealRecord(key: ByteArray, sessionId: ByteArray, dir: Int, seq: Long, plaintext: ByteArray): ByteArray {
        if (plaintext.size > MAX_RECORD) fail("record-too-large")
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, recordNonce(dir, seq)))
        c.updateAAD(recordAad(sessionId, dir, seq))
        return u64be(seq) + c.doFinal(plaintext)
    }

    fun openRecord(key: ByteArray, sessionId: ByteArray, dir: Int, record: ByteArray): Pair<Long, ByteArray> {
        if (record.size < 24) fail("decrypt-failed")
        if (record.size > 24 + MAX_RECORD) fail("record-too-large")
        val seq = ByteBuffer.wrap(record, 0, 8).long
        if (seq < 0 || seq > MAX_SAFE_INTEGER) fail("decrypt-failed")
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, recordNonce(dir, seq)))
            c.updateAAD(recordAad(sessionId, dir, seq))
            seq to c.doFinal(record, 8, record.size - 8)
        } catch (_: Exception) {
            fail("decrypt-failed")
        }
    }

    enum class Side { INITIATOR, RESPONDER }

    /** One established session; calls may be in flight together. */
    class Channel internal constructor(val side: Side, private val keys: Keys, private val establishedAt: Long, val peer: PqTrust.VerifiedBinding) {
        val sessionIdHex: String = PqHex.encode(keys.sessionId)
        private var lastUsed = establishedAt
        private var nextSeq = 0L
        private var maxSeen = -1L
        private val seen = HashSet<Long>()

        @Synchronized
        fun expired(now: Long) = now - lastUsed > IDLE_MS || now - establishedAt > MAX_LIFETIME_MS

        private fun live(now: Long) {
            if (now - lastUsed > IDLE_MS || now - establishedAt > MAX_LIFETIME_MS) fail("session-expired")
            lastUsed = now
        }

        @Synchronized
        fun sealRequest(plaintext: ByteArray, now: Long): Pair<Long, ByteArray> {
            if (side != Side.INITIATOR) fail("session-malformed")
            live(now)
            val seq = nextSeq++
            return seq to sealRecord(keys.i2r, keys.sessionId, DIR_INITIATOR, seq, plaintext)
        }

        fun openResponse(seq: Long, record: ByteArray): ByteArray {
            if (side != Side.INITIATOR) fail("session-malformed")
            val (got, pt) = openRecord(keys.r2i, keys.sessionId, DIR_RESPONDER, record)
            if (got != seq) fail("replay")
            return pt
        }

        @Synchronized
        fun openRequest(record: ByteArray, now: Long): Pair<Long, ByteArray> {
            if (side != Side.RESPONDER) fail("session-malformed")
            live(now)
            val r = openRecord(keys.i2r, keys.sessionId, DIR_INITIATOR, record)
            if (seen.contains(r.first) || r.first + 1024 <= maxSeen) fail("replay")
            seen.add(r.first)
            if (r.first > maxSeen) {
                maxSeen = r.first
                seen.removeAll { it + 1024 <= maxSeen }
            }
            return r
        }

        fun sealResponse(seq: Long, plaintext: ByteArray): ByteArray {
            if (side != Side.RESPONDER) fail("session-malformed")
            return sealRecord(keys.r2i, keys.sessionId, DIR_RESPONDER, seq, plaintext)
        }

        @Synchronized
        fun close() {
            keys.i2r.fill(0); keys.r2i.fill(0)
            lastUsed = Long.MIN_VALUE / 2
        }
    }
}
