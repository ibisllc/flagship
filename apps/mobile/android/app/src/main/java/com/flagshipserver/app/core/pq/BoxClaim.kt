package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import org.bouncycastle.crypto.digests.SHA512Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class BoxClaimException(val code: String) : Exception(code)

/**
 * `flagship/box-claim/v1`, the Kotlin twin of packages/protocol/src/boxClaim.ts. DRAFT, pending
 * external review alongside `flagship/pq-session/v1`. Spec: docs/retail-box-setup.md §7, §15.
 * Vectors: packages/protocol/test-vectors/box-claim/. The box half exists so the mock box in the
 * gym speaks the same bytes a real box does.
 */
object BoxClaim {
    const val TAG = "flagship/box-claim/v1"
    const val TAG_KEYS = "flagship/box-claim-keys/v1"
    const val TAG_CONFIRM = "flagship/box-claim-confirm/v1"
    const val TAG_RECORD = "flagship/box-claim-record/v1"
    const val TAG_RECEIPT = "flagship/box-claim-receipt/v1"
    const val TAG_KEY = "flagship/box-claim-key/v1"
    const val TAG_SETUP_CODE_KEY = "flagship/box-setup-code-key/v1"
    const val TAG_MAILBOX = "flagship/box-claim-mailbox/v1"

    const val PRESS_WINDOW_MS = 20_000L
    const val INSTRUCTION_PAUSE_MIN_MS = 2_000L
    const val INSTRUCTION_PAUSE_MAX_MS = 6_000L
    const val PRESS_AFTER_INSTRUCTION_MS = 5_000L
    const val ARM_LATENCY_MS = 1_000L
    const val POWER_KEY_BURST_END_MS = 2_000L
    const val SETUP_CODE_CHARS = 20
    const val MAX_RECORD = 64 * 1024
    const val MAX_MESSAGE = MAX_RECORD + 1024
    const val DIR_PHONE = 1
    const val DIR_BOX = 2
    const val FRAME_HANDSHAKE = 0x01
    const val FRAME_RECORD = 0x02

    const val BLE_SERVICE_UUID = "6f3c1a00-5e1b-4f0a-9c55-f1a95e5b0c01"
    const val BLE_INBOX_UUID = "6f3c1a01-5e1b-4f0a-9c55-f1a95e5b0c01"
    const val BLE_OUTBOX_UUID = "6f3c1a02-5e1b-4f0a-9c55-f1a95e5b0c01"

    enum class Mode(val wire: String) { OPEN("open"), CODE("code");
        companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } }
    }

    enum class AdvertState(val wire: String) { UNCLAIMED("unclaimed"), RESET_WINDOW("reset-window");
        companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } }
    }

    private fun fail(code: String): Nothing = throw BoxClaimException(code)
    private fun utf8(s: String) = s.toByteArray(Charsets.UTF_8)
    private fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)
    private fun sha512(b: ByteArray) = MessageDigest.getInstance("SHA-512").digest(b)
    private fun u64be(n: Long) = ByteBuffer.allocate(8).putLong(n).array()
    private fun u32be(n: Int) = ByteBuffer.allocate(4).putInt(n).array()
    private val rng = SecureRandom()

    private fun random(n: Int, fixed: ByteArray?): ByteArray {
        if (fixed != null) {
            if (fixed.size != n) fail("randomness")
            return fixed.copyOf()
        }
        return ByteArray(n).also { rng.nextBytes(it) }
    }

    private fun str(o: JsonObject, k: String): String? = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun hexField(o: JsonObject, k: String, n: Int, code: String = "claim-malformed"): ByteArray {
        val s = str(o, k) ?: fail(code)
        if (s.length != n * 2) fail(code)
        return PqHex.decode(s) ?: fail(code)
    }

    private fun exact(w: JsonElement?, keys: List<String>, code: String = "claim-malformed"): JsonObject {
        val o = w as? JsonObject ?: fail(code)
        if (o.keys.sorted() != keys.sorted()) fail(code)
        return o
    }

    private fun safeInt(e: JsonElement?): Long? {
        val p = e as? JsonPrimitive ?: return null
        if (p.isString || p is JsonNull || p.booleanOrNull != null) return null
        val d = p.doubleOrNull ?: return null
        if (d < 0 || d > 9_007_199_254_740_991.0 || d != Math.rint(d)) return null
        return d.toLong()
    }

    private fun isOne(e: JsonElement?) = safeInt(e) == 1L

    // ── setup code ──

    private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    fun generateSetupCode(randomness: ByteArray? = null): String {
        val r = random(13, randomness)
        val acc = BigInteger(1, r).shiftRight(4)
        r.fill(0)
        val sb = StringBuilder()
        for (i in SETUP_CODE_CHARS - 1 downTo 0) sb.append(CROCKFORD[acc.shiftRight(i * 5).toInt() and 31])
        return sb.toString()
    }

    fun normalizeSetupCode(input: String): String? {
        val s = input.uppercase().replace(Regex("[\\s-]"), "").replace(Regex("[IL]"), "1").replace("O", "0")
        if (s.length != SETUP_CODE_CHARS || !s.all { it in CROCKFORD }) return null
        return s
    }

    fun formatSetupCode(code: String): String = code.chunked(4).joinToString("-")

    private fun canonicalCode(code: String) = normalizeSetupCode(code) ?: fail("claim-malformed")

    fun setupCodeKey(code: String): ByteArray = sha256(utf8("$TAG_SETUP_CODE_KEY|${canonicalCode(code)}"))

    fun setupCodeMailboxId(code: String): String = PqHex.encode(sha256(utf8("$TAG_MAILBOX|${canonicalCode(code)}")))

    fun setupCodeLink(code: String, apex: String = "flagshipserver.com") = "https://$apex/claim#c=${canonicalCode(code)}&v=1"

    fun parseSetupCodeLink(link: String): String? {
        val m = Regex("^https://[a-z0-9.-]+/claim#(.*)$").find(link.trim()) ?: return null
        val params = LinkedHashMap<String, String>()
        for (pair in m.groupValues[1].split("&")) {
            if (pair.isEmpty()) continue
            val kv = pair.split("=", limit = 2)
            val k = java.net.URLDecoder.decode(kv[0], "UTF-8")
            if (k !in params) params[k] = if (kv.size > 1) java.net.URLDecoder.decode(kv[1], "UTF-8") else ""
        }
        if (params["v"] != "1") return null
        val c = params["c"]?.takeIf { it.isNotEmpty() } ?: return null
        return normalizeSetupCode(c)
    }

    /** A box's scan-response service data: version, state byte, 8-byte per-boot id. */
    fun parseAdvert(serviceData: ByteArray): Pair<AdvertState, String>? {
        if (serviceData.size != 10 || serviceData[0].toInt() != 1) return null
        val state = when (serviceData[1].toInt()) { 1 -> AdvertState.UNCLAIMED; 2 -> AdvertState.RESET_WINDOW; else -> return null }
        return state to PqHex.encode(serviceData.copyOfRange(2, 10))
    }

    // ── handshake ──

    data class Randomness(val ephemeralSeed: ByteArray? = null, val nonce: ByteArray? = null, val encapsulation: ByteArray? = null)

    data class Hello(val mode: Mode, val ephemeralPub: String, val nonce: String) {
        val json: JsonObject get() = buildJsonObject { put("v", 1); put("t", "hello"); put("mode", mode.wire); put("ephemeralPub", ephemeralPub); put("nonce", nonce) }
        internal val bytes get() = utf8(listOf(TAG, "hello", mode.wire, ephemeralPub, nonce).joinToString("|"))

        companion object {
            fun parse(w: JsonElement?): Hello {
                val o = exact(w, listOf("ephemeralPub", "mode", "nonce", "t", "v"))
                val m = Mode.of(str(o, "mode"))
                if (!isOne(o["v"]) || str(o, "t") != "hello" || m == null) fail("claim-malformed")
                hexField(o, "ephemeralPub", PqHybrid.HYBRID_SEAL_PUBLIC_KEY_LEN)
                hexField(o, "nonce", 32)
                return Hello(m, str(o, "ephemeralPub")!!, str(o, "nonce")!!)
            }
        }
    }

    data class Accept(val mode: Mode, val state: AdvertState, val enc: String, val ephemeralPub: String, val nonce: String) {
        val json: JsonObject get() = buildJsonObject {
            put("v", 1); put("t", "accept"); put("mode", mode.wire); put("state", state.wire); put("enc", enc); put("ephemeralPub", ephemeralPub); put("nonce", nonce)
        }
        internal val bytes get() = utf8(listOf(TAG, "accept", mode.wire, state.wire, enc, ephemeralPub, nonce).joinToString("|"))

        companion object {
            fun parse(w: JsonElement?): Accept {
                val o = exact(w, listOf("enc", "ephemeralPub", "mode", "nonce", "state", "t", "v"))
                val m = Mode.of(str(o, "mode"))
                val st = AdvertState.of(str(o, "state"))
                if (!isOne(o["v"]) || str(o, "t") != "accept" || m == null || st == null) fail("claim-malformed")
                hexField(o, "enc", PqHybrid.HYBRID_SEAL_ENC_LEN)
                hexField(o, "ephemeralPub", PqHybrid.HYBRID_SEAL_PUBLIC_KEY_LEN)
                hexField(o, "nonce", 32)
                return Accept(m, st, str(o, "enc")!!, str(o, "ephemeralPub")!!, str(o, "nonce")!!)
            }
        }
    }

    private fun finishEncBytes(enc: String) = utf8("$TAG|finish|$enc")

    internal class Schedule(val phoneKey: ByteArray, val boxKey: ByteArray, val confirmKey: ByteArray, val sessionId: ByteArray, val transcript: ByteArray)

    private fun schedule(mode: Mode, codeKey: ByteArray?, ss1: ByteArray, ss2: ByteArray, th: ByteArray): Schedule {
        val salt = sha512(utf8("$TAG|${mode.wire}|") + (codeKey ?: ByteArray(0)))
        val prk = HKDFBytesGenerator(SHA512Digest()).extractPRK(salt, ss1 + ss2)
        fun ex(label: String, n: Int): ByteArray {
            val g = HKDFBytesGenerator(SHA512Digest())
            g.init(HKDFParameters.skipExtractParameters(prk, utf8("$TAG_KEYS|$label|") + th))
            return ByteArray(n).also { g.generateBytes(it, 0, n) }
        }
        val s = Schedule(ex("phone-to-box", 32), ex("box-to-phone", 32), ex("confirm", 32), ex("session-id", 16), th)
        prk.fill(0)
        return s
    }

    private fun confirmTag(k: ByteArray, who: String, th: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(k, "HmacSHA256"))
        return mac.doFinal(utf8("$TAG_CONFIRM|$who|") + th)
    }

    private fun checkSealKey(pub: ByteArray) {
        try { PqHybrid.parseHybridSealPublicKey(pub) } catch (_: PqHybridException) { fail("bad-public-key") }
    }

    /** The phone between hello and accept; single use. Mode `code` needs the scanned code. */
    class PhoneStart(val mode: Mode, code: String? = null, randomness: Randomness = Randomness()) {
        private val codeKey: ByteArray?
        private var seed: ByteArray?
        val hello: Hello

        init {
            if ((mode == Mode.CODE) != (code != null)) fail("claim-malformed")
            codeKey = code?.let { setupCodeKey(it) }
            val s = random(32, randomness.ephemeralSeed)
            hello = Hello(mode, PqHex.encode(PqHybrid.xwingPublicKey(s)), PqHex.encode(random(32, randomness.nonce)))
            seed = s
        }

        fun finish(accept: JsonElement?, randomness: Randomness = Randomness()): Pair<JsonObject, PhonePending> {
            val s = seed ?: fail("claim-malformed")
            seed = null
            try {
                val a = Accept.parse(accept)
                if (a.mode != mode) fail("mode-mismatch")
                val ss1 = try { PqHybrid.xwingDecapsulate(PqHex.decode(a.enc)!!, s) } catch (_: Exception) { fail("bad-public-key") }
                val boxPub = PqHex.decode(a.ephemeralPub)!!
                checkSealKey(boxPub)
                val eseed = random(64, randomness.encapsulation)
                val (ct, ss2) = try { PqHybrid.xwingEncapsulate(boxPub, eseed) } catch (_: Exception) { fail("bad-public-key") } finally { eseed.fill(0) }
                val encHex = PqHex.encode(ct)
                val th = sha512(hello.bytes + a.bytes + finishEncBytes(encHex))
                val sch = schedule(mode, codeKey, ss1, ss2, th)
                ss1.fill(0); ss2.fill(0)
                val fin = buildJsonObject { put("v", 1); put("t", "finish"); put("enc", encHex); put("confirm", PqHex.encode(confirmTag(sch.confirmKey, "phone", th))) }
                return fin to PhonePending(sch, a.state)
            } finally {
                s.fill(0)
            }
        }
    }

    class PhonePending internal constructor(private val schedule: Schedule, val state: AdvertState) {
        private var used = false

        fun confirm(ready: JsonElement?): Channel {
            if (used) fail("claim-malformed")
            used = true
            val o = exact(ready, listOf("confirm", "t", "v"))
            if (!isOne(o["v"]) || str(o, "t") != "ready") fail("claim-malformed")
            val c = hexField(o, "confirm", 32)
            if (!MessageDigest.isEqual(c, confirmTag(schedule.confirmKey, "box", schedule.transcript))) fail("confirm-failed")
            return Channel(Role.PHONE, schedule, state)
        }
    }

    /** The box between accept and finish (the mock box; a real box runs the TS code). */
    class BoxPending(hello: JsonElement?, state: AdvertState, codeKey: ByteArray?, randomness: Randomness = Randomness()) {
        private val h = Hello.parse(hello)
        val accept: Accept
        private val codeKey: ByteArray?
        private val ss1: ByteArray
        private var seed: ByteArray?

        init {
            if (h.mode == Mode.CODE && codeKey == null) fail("no-code")
            val phonePub = PqHex.decode(h.ephemeralPub)!!
            checkSealKey(phonePub)
            val eseed = random(64, randomness.encapsulation)
            val (ct, ss) = try { PqHybrid.xwingEncapsulate(phonePub, eseed) } catch (_: Exception) { fail("bad-public-key") } finally { eseed.fill(0) }
            val s = random(32, randomness.ephemeralSeed)
            accept = Accept(h.mode, state, PqHex.encode(ct), PqHex.encode(PqHybrid.xwingPublicKey(s)), PqHex.encode(random(32, randomness.nonce)))
            this.codeKey = if (h.mode == Mode.CODE) codeKey else null
            ss1 = ss
            seed = s
        }

        fun complete(finish: JsonElement?): Pair<JsonObject, Channel> {
            val s = seed ?: fail("claim-malformed")
            seed = null
            try {
                val o = exact(finish, listOf("confirm", "enc", "t", "v"))
                if (!isOne(o["v"]) || str(o, "t") != "finish") fail("claim-malformed")
                val enc = hexField(o, "enc", PqHybrid.HYBRID_SEAL_ENC_LEN)
                val conf = hexField(o, "confirm", 32)
                val ss2 = try { PqHybrid.xwingDecapsulate(enc, s) } catch (_: Exception) { fail("bad-public-key") }
                val th = sha512(h.bytes + accept.bytes + finishEncBytes(str(o, "enc")!!))
                val sch = schedule(h.mode, codeKey, ss1, ss2, th)
                ss2.fill(0); ss1.fill(0)
                if (!MessageDigest.isEqual(conf, confirmTag(sch.confirmKey, "phone", th))) fail(if (h.mode == Mode.CODE) "wrong-code" else "confirm-failed")
                val ready = buildJsonObject { put("v", 1); put("t", "ready"); put("confirm", PqHex.encode(confirmTag(sch.confirmKey, "box", th))) }
                return ready to Channel(Role.BOX, sch, accept.state)
            } finally {
                s.fill(0)
            }
        }
    }

    // ── records ──

    private fun recordAad(sid: ByteArray, dir: Int, seq: Long) = utf8("$TAG_RECORD|") + sid + byteArrayOf(dir.toByte()) + u64be(seq)
    private fun recordNonce(dir: Int, seq: Long) = u32be(dir) + u64be(seq)

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
        if (seq < 0 || seq > PqHybrid.MAX_SAFE_INTEGER) fail("decrypt-failed")
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, recordNonce(dir, seq)))
            c.updateAAD(recordAad(sessionId, dir, seq))
            seq to c.doFinal(record, 8, record.size - 8)
        } catch (_: Exception) {
            fail("decrypt-failed")
        }
    }

    enum class Role { PHONE, BOX }

    /** One side of an open claim session; records arrive in order, so any gap is refused. */
    class Channel internal constructor(val role: Role, private val keys: Schedule, val advertState: AdvertState) {
        val sessionIdHex: String = PqHex.encode(keys.sessionId)
        val transcriptHex: String = PqHex.encode(keys.transcript)
        private var sendSeq = 0L
        private var recvSeq = 0L

        fun seal(plaintext: ByteArray): ByteArray {
            val mine = role == Role.PHONE
            val out = sealRecord(if (mine) keys.phoneKey else keys.boxKey, keys.sessionId, if (mine) DIR_PHONE else DIR_BOX, sendSeq, plaintext)
            sendSeq++
            return out
        }

        fun open(record: ByteArray): ByteArray {
            val mine = role == Role.PHONE
            val (seq, pt) = openRecord(if (mine) keys.boxKey else keys.phoneKey, keys.sessionId, if (mine) DIR_BOX else DIR_PHONE, record)
            if (seq != recvSeq) fail("replay")
            recvSeq++
            return pt
        }

        fun openJson(record: ByteArray): JsonElement {
            val pt = open(record)
            return try {
                val dec = Charsets.UTF_8.newDecoder()
                Json.parseToJsonElement(dec.decode(ByteBuffer.wrap(pt)).toString())
            } catch (_: Exception) {
                fail("claim-malformed")
            }
        }
    }

    // ── messages inside the channel ──

    data class WiFiConfig(val ssid: String, val psk: String, val regulatoryRegion: String, val issuedAt: Long) {
        val isValid: Boolean get() {
            val n = utf8(ssid).size
            if (n < 1 || n > 32) return false
            if (!(psk.isEmpty() || psk.length in 8..63 || Regex("^[0-9a-fA-F]{64}$").matches(psk))) return false
            if (!Regex("^(?:[A-Z]{2})?$").matches(regulatoryRegion)) return false
            return issuedAt >= 0
        }
    }

    data class WifiNetwork(val ssid: String, val security: String, val signal: Int, val band: String) {
        val supported: Boolean get() = security != "enterprise" && security != "wep"
    }

    val NETWORK_FAILURES = listOf("no-link", "network-not-found", "wrong-password", "unsupported-security", "no-dhcp", "no-dns", "captive-portal", "relay-unreachable")
    private val PRESS_REFUSALS = setOf("no-press", "burst", "long-press", "late", "contention", "not-armed", "busy")
    private val REFUSALS = setOf("no-grant", "recipe-invalid", "recipe-expired", "already-claimed", "window-closed", "entropy", "out-of-order")

    sealed class PhoneMessage {
        object Arm : PhoneMessage()
        object WifiScan : PhoneMessage()
        object Abort : PhoneMessage()
        data class Claim(val recipe: String) : PhoneMessage()
        data class Network(val wifi: WiFiConfig?) : PhoneMessage()

        /** JSON in the field order the TS reference writes. */
        val jsonText: String get() {
            fun q(s: String) = JsonPrimitive(s).toString()
            return when (this) {
                Arm -> """{"t":"arm"}"""
                WifiScan -> """{"t":"wifi-scan"}"""
                Abort -> """{"t":"abort"}"""
                is Claim -> """{"t":"claim","recipe":${q(recipe)}}"""
                is Network -> if (wifi == null) """{"t":"network","wifi":null}""" else
                    """{"t":"network","wifi":{"ssid":${q(wifi.ssid)},"psk":${q(wifi.psk)},"regulatoryRegion":${q(wifi.regulatoryRegion)},"issuedAt":${wifi.issuedAt}}}"""
            }
        }

        companion object {
            fun parse(w: JsonElement?): PhoneMessage {
                val o = w as? JsonObject ?: fail("claim-malformed")
                return when (str(o, "t")) {
                    "arm" -> { exact(o, listOf("t")); Arm }
                    "wifi-scan" -> { exact(o, listOf("t")); WifiScan }
                    "abort" -> { exact(o, listOf("t")); Abort }
                    "claim" -> {
                        exact(o, listOf("recipe", "t"))
                        val r = str(o, "recipe") ?: fail("claim-malformed")
                        if (r.length > MAX_RECORD - 64) fail("claim-malformed")
                        Claim(r)
                    }
                    "network" -> {
                        exact(o, listOf("t", "wifi"))
                        if (o["wifi"] is JsonNull) return Network(null)
                        val wo = exact(o["wifi"], listOf("issuedAt", "psk", "regulatoryRegion", "ssid"))
                        val cfg = WiFiConfig(str(wo, "ssid") ?: fail("claim-malformed"), str(wo, "psk") ?: fail("claim-malformed"),
                            str(wo, "regulatoryRegion") ?: fail("claim-malformed"), safeInt(wo["issuedAt"]) ?: fail("claim-malformed"))
                        if (!cfg.isValid) fail("claim-malformed")
                        Network(cfg)
                    }
                    else -> fail("claim-malformed")
                }
            }
        }
    }

    sealed class BoxMessage {
        object Armed : BoxMessage()
        data class Press(val atMs: Long, val count: Int, val long: Boolean) : BoxMessage()
        data class PressResult(val ok: Boolean, val reason: String?) : BoxMessage()
        data class WifiList(val networks: List<WifiNetwork>) : BoxMessage()
        data class Receipt(val receipt: JsonElement) : BoxMessage()
        data class NetworkStatus(val stage: String, val via: String, val failure: String?) : BoxMessage()
        data class Refused(val reason: String) : BoxMessage()

        companion object {
            fun parse(w: JsonElement?): BoxMessage {
                val o = w as? JsonObject ?: fail("claim-malformed")
                return when (str(o, "t")) {
                    "armed" -> Armed
                    "press" -> {
                        val at = safeInt(o["atMs"]) ?: fail("claim-malformed")
                        val c = safeInt(o["count"]) ?: fail("claim-malformed")
                        val l = (o["long"] as? JsonPrimitive)?.booleanOrNull ?: fail("claim-malformed")
                        Press(at, c.toInt(), l)
                    }
                    "press-result" -> {
                        val ok = (o["ok"] as? JsonPrimitive)?.booleanOrNull ?: fail("claim-malformed")
                        if (ok) PressResult(true, null) else PressResult(false, str(o, "reason")?.takeIf { it in PRESS_REFUSALS } ?: fail("claim-malformed"))
                    }
                    "wifi-list" -> {
                        val arr = o["networks"] as? JsonArray ?: fail("claim-malformed")
                        WifiList(arr.mapNotNull { e ->
                            val n = e as? JsonObject ?: return@mapNotNull null
                            WifiNetwork(str(n, "ssid") ?: return@mapNotNull null, str(n, "security") ?: return@mapNotNull null,
                                safeInt(n["signal"])?.toInt() ?: return@mapNotNull null, str(n, "band") ?: return@mapNotNull null)
                        })
                    }
                    "receipt" -> Receipt(o["receipt"] as? JsonObject ?: fail("claim-malformed"))
                    "network-status" -> {
                        val stage = str(o, "stage")?.takeIf { it in setOf("connecting", "online", "failed") } ?: fail("claim-malformed")
                        val via = str(o, "via")?.takeIf { it == "ethernet" || it == "wifi" } ?: fail("claim-malformed")
                        val f = if (stage == "failed") str(o, "failure")?.takeIf { it in NETWORK_FAILURES } ?: fail("claim-malformed") else null
                        NetworkStatus(stage, via, f)
                    }
                    "refused" -> Refused(str(o, "reason")?.takeIf { it in REFUSALS } ?: fail("claim-malformed"))
                    else -> fail("claim-malformed")
                }
            }
        }
    }

    // ── the phone's press check (§7.4) ──

    fun instructionPauseMs(randomness: ByteArray? = null): Long {
        val r = random(2, randomness)
        val span = INSTRUCTION_PAUSE_MAX_MS - INSTRUCTION_PAUSE_MIN_MS
        val v = (((r[0].toInt() and 0xff) shl 8) or (r[1].toInt() and 0xff)) / 65536.0
        return INSTRUCTION_PAUSE_MIN_MS + Math.floor(v * (span + 1)).toLong()
    }

    enum class PressVerdict { OK, EARLY, LATE, BURST }

    fun judgePressReport(armSentAt: Long, instructionAt: Long, atMs: Long, count: Int, long: Boolean, receivedAt: Long): PressVerdict {
        if (count != 1 || long) return PressVerdict.BURST
        val latest = armSentAt + ARM_LATENCY_MS + atMs
        if (receivedAt < instructionAt || latest < instructionAt) return PressVerdict.EARLY
        if (armSentAt + atMs - instructionAt > PRESS_AFTER_INSTRUCTION_MS) return PressVerdict.LATE
        if (receivedAt - instructionAt > PRESS_AFTER_INSTRUCTION_MS + POWER_KEY_BURST_END_MS + ARM_LATENCY_MS + 2_000) return PressVerdict.LATE
        return PressVerdict.OK
    }

    // ── the claim receipt (§7.6) ──

    data class Receipt(
        val mode: Mode, val serverDomain: String, val serial: String, val stkHybridPub: String, val bootKeyBindingSha256: String,
        val model: String, val imageVersion: String, val transcript: String, val issuedAt: Long, val signature: String = "",
    ) {
        val stkPubHex: String get() = stkHybridPub.substring(0, 64)
        val canonical: ByteArray get() = utf8(listOf(TAG_RECEIPT, mode.wire, serverDomain, serial, stkHybridPub, bootKeyBindingSha256, model, imageVersion, transcript, issuedAt.toString()).joinToString("|"))
        val json: JsonObject get() = buildJsonObject {
            put("v", 1); put("mode", mode.wire); put("serverDomain", serverDomain); put("serial", serial); put("stkHybridPub", stkHybridPub)
            put("bootKeyBindingSha256", bootKeyBindingSha256); put("model", model); put("imageVersion", imageVersion); put("transcript", transcript)
            put("issuedAt", issuedAt); put("signature", signature)
        }

        fun signed(sign: (String, ByteArray) -> ByteArray): Receipt {
            val sig = sign(TAG_RECEIPT, canonical)
            if (sig.size != PqHybrid.HYBRID_SIG_LEN) fail("bad-receipt")
            return copy(signature = PqHex.encode(sig))
        }
    }

    private val RECEIPT_TEXT = Regex("^[A-Za-z0-9._+ -]{1,64}$")
    private val DOMAIN = Regex("^[a-z0-9][a-z0-9.-]{0,252}$")
    private val SERIAL = Regex("^[A-Za-z0-9_-]{8,64}$")
    private fun lowerHex(s: String?, n: Int) = s != null && s.length == n * 2 && PqHex.isHex(s)

    /**
     * Checks a receipt on the phone: shape, the hybrid signature under the key it names, and that it
     * was made in THIS session for the recipe the phone sent (`transcript-mismatch` otherwise).
     */
    fun verifyReceipt(wire: JsonElement?, transcriptHex: String, mode: Mode, serverDomain: String, serial: String): Receipt {
        val o = exact(wire, listOf("bootKeyBindingSha256", "imageVersion", "issuedAt", "mode", "model", "serial", "serverDomain", "signature", "stkHybridPub", "transcript", "v"), "bad-receipt")
        val m = Mode.of(str(o, "mode"))
        val dom = str(o, "serverDomain"); val ser = str(o, "serial"); val stk = str(o, "stkHybridPub"); val bkb = str(o, "bootKeyBindingSha256")
        val model = str(o, "model"); val img = str(o, "imageVersion"); val tr = str(o, "transcript"); val at = safeInt(o["issuedAt"]); val sig = str(o, "signature")
        if (!isOne(o["v"]) || m == null || dom == null || !DOMAIN.matches(dom) || ser == null || !SERIAL.matches(ser) ||
            !lowerHex(stk, PqHybrid.HYBRID_SIG_PUBLIC_KEY_LEN) || bkb == null || !(bkb.isEmpty() || lowerHex(bkb, 32)) ||
            model == null || !RECEIPT_TEXT.matches(model) || img == null || !RECEIPT_TEXT.matches(img) || !lowerHex(tr, 64) || at == null ||
            !lowerHex(sig, PqHybrid.HYBRID_SIG_LEN)) fail("bad-receipt")
        if (tr != transcriptHex) fail("transcript-mismatch")
        if (m != mode || dom != serverDomain || ser != serial) fail("bad-receipt")
        val r = Receipt(m, dom, ser, stk!!, bkb, model, img, tr!!, at, sig!!)
        try {
            PqHybrid.hybridVerify(PqHex.decode(stk)!!, TAG_RECEIPT, r.canonical, PqHex.decode(sig)!!)
        } catch (_: Exception) {
            fail("bad-receipt")
        }
        return r
    }

    // ── the phone's key pre-registration at `.com` (§4 step 8) ──

    data class ClaimKey(val username: String, val serial: String, val serverDomain: String, val stkPubHex: String, val issuedAt: Long) {
        val canonical: ByteArray get() = utf8(listOf(TAG_KEY, username, serial, serverDomain, stkPubHex.lowercase(), issuedAt.toString()).joinToString("|"))
        fun verify(signature: ByteArray, publicKey: ByteArray) = PqHybrid.ed25519VerifyStrict(signature, canonical, publicKey)
    }

    // ── frames for small-MTU transports (BLE) ──

    fun encodeMessage(kind: Int, payload: ByteArray) = byteArrayOf(kind.toByte()) + payload

    fun decodeMessage(msg: ByteArray): Pair<Int, ByteArray> {
        if (msg.isEmpty()) fail("claim-malformed")
        val k = msg[0].toInt()
        if (k != FRAME_HANDSHAKE && k != FRAME_RECORD) fail("claim-malformed")
        return k to msg.copyOfRange(1, msg.size)
    }

    fun fragment(msg: ByteArray, mtu: Int): List<ByteArray> {
        if (mtu < 20) fail("claim-malformed")
        if (msg.size > MAX_MESSAGE) fail("record-too-large")
        val room = mtu - 1
        val out = ArrayList<ByteArray>()
        var o = 0
        do {
            val end = minOf(o + room, msg.size)
            val flags = (if (o == 0) 0x80 else 0) or (if (end == msg.size) 0x40 else 0)
            out.add(byteArrayOf(flags.toByte()) + msg.copyOfRange(o, end))
            o += room
        } while (o < msg.size)
        return out
    }

    class Reassembler {
        private var parts = java.io.ByteArrayOutputStream()
        private var open = false

        private fun reset() { parts = java.io.ByteArrayOutputStream(); open = false }

        fun push(frame: ByteArray): ByteArray? {
            if (frame.isEmpty()) fail("claim-malformed")
            val flags = frame[0].toInt() and 0xff
            if (flags and 0x3f != 0) fail("claim-malformed")
            val first = flags and 0x80 != 0
            if (first == open) { reset(); fail("claim-malformed") }
            open = true
            parts.write(frame, 1, frame.size - 1)
            if (parts.size() > MAX_MESSAGE) { reset(); fail("record-too-large") }
            if (flags and 0x40 == 0) return null
            val msg = parts.toByteArray()
            reset()
            return msg
        }
    }
}
