// voi.ci calls (docs/voici-calls.md §2-§3), the Kotlin twin of packages/protocol/src/voiciCalls.ts: the SDP profile,
// the caller's signed request (checked before the phone rings through), the owner's answer, the CA receipt, end and
// call-allow orders, the per-call X-Wing encapsulation, the frame layer (k(dir) from the shared secret and both
// records, an epoch key every 30,000 frames, 88-byte sealed frames, a replay window and a gap limit) and the sealed
// push / missed call. Vectors: packages/protocol/test-vectors/voici-calls/vectors.json.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import java.security.SecureRandom

enum class VoiciCallDir(val code: Int) { c2p(1), p2c(2) }

data class VoiciCallRequestCheckContext(
    val pageId: String,
    val acceptsCalls: Boolean,
    val origin: String,
    val caKeys: Collection<String>,
    val now: Long,
    val blocked: Set<String>? = null,
    val revoked: Set<String>? = null,
    val rateLimit: ((JsonObject) -> String?)? = null,
    val allowed: ((JsonObject) -> Boolean)? = null,
    val skipFresh: Boolean = false,
)

/** A checked call request: what the phone needs, plus the whole record for the answer's hash. */
data class VoiciCallRequest(
    val pageId: String,
    val conv: String,
    val callId: String,
    val from: String,
    val callerXwingPub: String,
    val offerSdp: String,
    val issuedAt: Long,
    val delegatePub: String,
    val json: JsonObject,
    /** What the caller is able to send: "audio" or "audio,video" (voici-calls-v2.md §1.1; absent on the wire = audio). */
    val media: String = VoiciCalls.MEDIA_AUDIO,
) {
    val hasVideo: Boolean get() = media == VoiciCalls.MEDIA_VIDEO
}

data class VoiciCallAnswerBody(
    val callId: String,
    val deviceRef: String,
    val requestHash: String,
    val xwingCiphertext: String,
    val answerSdp: String,
    val turnUser: String,
    val turnSecret: String,
    val issuedAt: Long,
    /** What the answering device is able to send; null = not on the wire (audio). */
    val media: String? = null,
)

data class VoiciMissedCall(val request: VoiciCallRequest, val ringingAt: Long, val endedAt: Long, val reason: String)

object VoiciCalls {
    const val TAG_REQUEST = "flagship/voici-call-request/v1"
    const val TAG_ANSWER = "flagship/voici-call-answer/v1"
    const val TAG_RECEIPT = "flagship/voici-call-receipt/v1"
    const val TAG_END = "flagship/voici-call-end/v1"
    const val TAG_ALLOW = "flagship/voici-call-allow/v1"
    const val TAG_FRAME = "flagship/voici-call-frame/v1"
    const val TAG_PUSH = "flagship/voici-call-push/v1"
    const val TAG_MISSED_CALL = "flagship/voici-missed-call/v1"

    const val SKEW_MS = 10 * 60_000L
    const val RING_MS = 45_000L
    const val MAX_CALL_MS = 60 * 60_000L
    const val RECEIPT_TTL_MS = MAX_CALL_MS + 5 * 60_000L
    const val MAX_SDP_BYTES = 16 * 1024
    const val MAX_REQUEST_BYTES = 40 * 1024
    const val FRAME_PLAINTEXT = 64
    const val FRAME_MAX = FRAME_PLAINTEXT - 1
    const val SEALED_FRAME = 8 + FRAME_PLAINTEXT + 16
    const val FRAMES_PER_EPOCH = 30_000L
    const val REPLAY_WINDOW = 128L
    const val MAX_GAP_FRAMES = 3000L
    const val MAX_CTR = 1L shl 32
    val END_REASONS = setOf("hangup", "cancel", "decline", "busy", "no-answer", "limit", "failed")
    val MISSED_REASONS = setOf("no-answer", "busy", "cancel", "decline")
    const val MEDIA_AUDIO = "audio"
    const val MEDIA_VIDEO = "audio,video"
    val MEDIA_VALUES = setOf(MEDIA_AUDIO, MEDIA_VIDEO)
    /** Sealed video frame sizes (voici-calls-v2.md §1.6): 1 KiB doubling to 1 MiB. */
    val VIDEO_BUCKETS: List<Int> = (0 until 11).map { 1024 shl it }
    val CAMERA_STATES = setOf("on", "off", "paused")
    private val VIDEO_EXTMAPS = listOf("urn:ietf:params:rtp-hdrext:sdes:mid", "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01")
    private val VP8 = Regex("^a=rtpmap:\\d+ VP8/90000$", RegexOption.IGNORE_CASE)

    private val PAGE_ID = Regex("^[0-9a-f]{32}$")
    private val USERNAME = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
    private val OPUS = Regex("^a=rtpmap:\\d+ opus/48000(/2)?$", RegexOption.IGNORE_CASE)
    private val FINGERPRINT = Regex("^a=fingerprint:sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$")
    private val PT_ATTR = Regex("^a=(rtpmap|fmtp|rtcp-fb):(\\d+) ")

    private fun str(e: JsonElement?) = VoiciJs.str(e)
    private fun hex(s: String?, bytes: Int? = null) = WebEnvelopes.isLowerHex(s, bytes)
    private fun isTime(n: Long) = n in 0..9_007_199_254_740_991L
    private fun join(vararg parts: Any) = VoiciJs.utf8(parts.joinToString("|"))
    private fun no(code: String) = VoiciOutcome.Refused(code)
    private fun badField(tag: String): Nothing = throw IllegalArgumentException(tag)

    fun sdpHash(sdp: String): String = WebEnvelopes.sha256Hex(sdp)
    fun deviceRef(devicePubHex: String): String = WebEnvelopes.sha256Hex(WebEnvelopes.hexToBytes(devicePubHex))

    // ── SDP ──

    private fun lines(sdp: String) = sdp.split(Regex("\r?\n"))

    /** The SDP rules (§0.3); null for a call description, else the refusal. */
    private fun sections(ls: List<String>): List<Pair<String, MutableList<String>>> {
        val out = ArrayList<Pair<String, MutableList<String>>>()
        for (l in ls) {
            if (l.startsWith("m=")) out.add(l.removePrefix("m=").split(" ")[0] to mutableListOf(l))
            else out.lastOrNull()?.second?.add(l)
        }
        return out
    }

    private fun isVideoExtmap(l: String) = VIDEO_EXTMAPS.any { l.endsWith(" $it") }

    fun checkSdp(sdp: String, media: String = MEDIA_AUDIO): String? {
        if (VoiciJs.utf8(sdp).size > MAX_SDP_BYTES) return "too-large"
        val ls = lines(sdp)
        val secs = sections(ls)
        if (media == MEDIA_VIDEO) {
            if (secs.size != 2 || secs[0].first != "audio" || secs[1].first != "video") return "bad-media"
            val v = secs[1].second
            val maps = v.filter { it.startsWith("a=rtpmap:") }
            if (maps.size != 1 || !VP8.matches(maps[0])) return "not-vp8"
            if (v.any { it.startsWith("a=extmap:") && !isVideoExtmap(it) }) return "video-extension"
        } else if (secs.size != 1 || secs[0].first != "audio") return "not-audio-only"
        val rtpmap = ls.firstOrNull { OPUS.matches(it) } ?: return "no-opus"
        val pt = rtpmap.removePrefix("a=rtpmap:").split(" ")[0]
        val fmtp = ls.firstOrNull { it.startsWith("a=fmtp:$pt ") }
        val params = LinkedHashMap<String, String?>()
        for (p in (fmtp?.removePrefix("a=fmtp:$pt ") ?: "").split(";")) {
            val kv = p.trim().split("=")
            if (!params.containsKey(kv[0])) params[kv[0]] = kv.getOrNull(1)
        }
        if (params["cbr"] != "1") return "not-cbr"
        if (params["usedtx"] != "0") return "dtx"
        if (ls.any { it.startsWith("a=extmap:") && it.contains("ssrc-audio-level") }) return "audio-level"
        if (ls.none { FINGERPRINT.matches(it) }) return "no-fingerprint"
        return null
    }

    private fun fmtpLine(pt: String) = "a=fmtp:$pt minptime=20;useinbandfec=1;cbr=1;usedtx=0;stereo=0;sprop-stereo=0;maxaveragebitrate=24000"

    /** Rewrites an audio SDP to the call profile (Opus only, the fixed fmtp, ptime 20, no header extension but MID). */
    fun mungeSdp(sdp: String): String {
        val eol = if (sdp.contains("\r\n")) "\r\n" else "\n"
        val ls = lines(sdp).filter { it.isNotEmpty() }
        val rtpmap = ls.firstOrNull { OPUS.matches(it) } ?: return sdp
        val pt = rtpmap.removePrefix("a=rtpmap:").split(" ")[0]
        val hasFmtp = ls.any { it.startsWith("a=fmtp:$pt ") }
        val vpt = ls.firstOrNull { VP8.matches(it) }?.removePrefix("a=rtpmap:")?.split(" ")?.get(0)
        val rtx = ls.filter { it.startsWith("a=ssrc-group:FID ") }.mapNotNull { it.split(" ").getOrNull(2) }.toSet()
        val out = ArrayList<String>()
        var inAudio = false
        var inVideo = false
        for (l in ls) {
            if (l.startsWith("m=")) {
                inAudio = l.startsWith("m=audio ")
                inVideo = l.startsWith("m=video ") && vpt != null
                if (inAudio || inVideo) {
                    out.add((l.split(" ").take(3) + (if (inAudio) pt else vpt!!)).joinToString(" "))
                    continue
                }
            }
            if (inVideo) {
                if (l.startsWith("a=extmap:") && !isVideoExtmap(l)) continue
                if (l == "a=extmap-allow-mixed" || l.startsWith("a=ssrc-group:FID ")) continue
                val m = PT_ATTR.find(l)
                if (m != null && m.groupValues[2] != vpt) continue
                if (l.startsWith("a=ssrc:") && l.removePrefix("a=ssrc:").split(" ")[0] in rtx) continue
                out.add(l)
                continue
            }
            if (inAudio) {
                if ((l.startsWith("a=extmap:") && !l.endsWith(" urn:ietf:params:rtp-hdrext:sdes:mid")) || l == "a=extmap-allow-mixed") continue
                val m = PT_ATTR.find(l)
                if (m != null && m.groupValues[2] != pt) continue
                if (l.startsWith("a=fmtp:$pt ")) { out.add(fmtpLine(pt)); continue }
                if (l.startsWith("a=ptime:")) continue
                out.add(l)
                if (l == rtpmap) {
                    if (!hasFmtp) out.add(fmtpLine(pt))
                    out.add("a=ptime:20")
                }
                continue
            }
            out.add(l)
        }
        return out.joinToString(eol) + eol
    }

    fun sdpFingerprint(sdp: String): String? = lines(sdp).firstOrNull { FINGERPRINT.matches(it) }?.removePrefix("a=fingerprint:")

    // ── request ──

    /** [media] null = not on the wire (audio); present, it is appended (voici-calls-v2.md §1.1). */
    fun canonicalRequest(pageId: String, conv: String, callId: String, callerXwingPub: String, offerSdp: String, issuedAt: Long, media: String? = null): ByteArray {
        if (!(PAGE_ID.matches(pageId) && hex(conv, 32) && hex(callId, 16) && hex(callerXwingPub, PqHybrid.HYBRID_SEAL_PUBLIC_KEY_LEN) && isTime(issuedAt) &&
                (media == null || media in MEDIA_VALUES))) badField(TAG_REQUEST)
        val parts = mutableListOf<Any>(TAG_REQUEST, pageId, conv, callId, callerXwingPub, sdpHash(offerSdp), issuedAt)
        if (media != null) parts.add(media)
        return join(*parts.toTypedArray())
    }

    private val REQUEST_KEYS = listOf("v", "kind", "pageId", "conv", "callId", "from", "callerXwingPub", "offerSdp", "issuedAt", "cred", "sig")

    private class Fields(val o: JsonObject, val pageId: String, val conv: String, val callId: String, val from: String, val xpub: String, val sdp: String, val at: Long, val sig: String, val cred: JsonObject, val media: String?) {
        fun bytes() = canonicalRequest(pageId, conv, callId, xpub, sdp, at, media)
    }

    private fun fields(v: JsonElement?): Fields? {
        val o = VoiciJs.obj(v) ?: return null
        if (!(VoiciJs.exactKeys(o, REQUEST_KEYS) || VoiciJs.exactKeys(o, REQUEST_KEYS + "media")) || !VoiciJs.isNumEq(o["v"], 1) || str(o["kind"]) != "voici-call-request") return null
        val media = if (o.containsKey("media")) (str(o["media"]) ?: return null) else null
        val sig = str(o["sig"]).takeIf { hex(it, 64) } ?: return null
        val cred = VoiciJs.obj(o["cred"]) ?: return null
        val from = str(o["from"]).takeIf { hex(it, 32) } ?: return null
        val f = Fields(o, str(o["pageId"]) ?: return null, str(o["conv"]) ?: return null, str(o["callId"]) ?: return null, from,
            str(o["callerXwingPub"]) ?: return null, str(o["offerSdp"]) ?: return null, VoiciJs.time(o["issuedAt"]) ?: return null, sig, cred, media)
        return try { f.bytes(); f } catch (_: IllegalArgumentException) { null }
    }

    /** H(request bytes) for a signed-in request or, by its kind, an anonymous one (VoiciCallModes). */
    fun requestHash(request: JsonElement): String? = requestBytes(request)?.let { WebEnvelopes.sha256Hex(it) }

    /** The canonical bytes of a wire request (the frame keys' transcript), null when it doesn't parse. */
    fun requestBytes(request: JsonElement): ByteArray? =
        if (VoiciCallModes.isAnon(request)) VoiciCallModes.anonBytes(request) else fields(request)?.bytes()

    /** A signed-in request's check, or by its kind an anonymous one's (an "anyone" page; [callsFrom] is the page's rule). */
    fun checkAnyRequest(input: JsonElement?, ctx: VoiciCallRequestCheckContext, callsFrom: String): VoiciOutcome<VoiciCallRequest> =
        if (VoiciCallModes.isAnon(input)) VoiciCallModes.checkAnon(input, ctx.pageId, ctx.acceptsCalls, callsFrom, ctx.now, ctx.blocked, ctx.skipFresh)
        else checkRequest(input, ctx)

    /**
     * The request checks, cheapest first (§6): size, shape, page, calls on, blocked, revoked, rate limits, attestation,
     * delegation, thread statement, conv, SDP, the caller's X-Wing key, B's signature, freshness, the owner's rule.
     */
    fun checkRequest(input: Any?, ctx: VoiciCallRequestCheckContext): VoiciOutcome<VoiciCallRequest> {
        val raw: JsonElement = when (input) {
            is String -> {
                if (VoiciJs.utf8(input).size > MAX_REQUEST_BYTES) return no("too-large")
                VoiciJs.parseJson(input) ?: return no("malformed")
            }
            is JsonPrimitive -> if (input.isString) return checkRequest(input.content, ctx) else return no("malformed")
            is JsonElement -> {
                if (VoiciJs.utf8(input.toString()).size > MAX_REQUEST_BYTES) return no("too-large")
                input
            }
            else -> return no("malformed")
        }
        val f = fields(raw) ?: return no("malformed")
        val c = f.cred
        if (!VoiciJs.exactKeys(c, listOf("attestation", "delegation", "delegationSig", "threadStmt", "threadSig"))) return no("malformed")
        if (f.pageId != ctx.pageId) return no("wrong-audience")
        if (!ctx.acceptsCalls) return no("calls-off")
        if (ctx.blocked?.contains(f.from) == true) return no("blocked")
        val dp = str(VoiciJs.obj(c["delegation"])?.get("delegatePub"))
        if (dp != null && ctx.revoked?.contains(dp) == true) return no("revoked")
        ctx.rateLimit?.invoke(f.o)?.let { return no(it) }
        val att = MessagesAttestations.checkMessagesKeyAttestation(c["attestation"], ctx.caKeys, ctx.now, f.from).valueOrNull() ?: return no("bad-attestation")
        val del = WebDelegations.checkWebDelegation(c["delegation"], str(c["delegationSig"]),
            WebDelegations.Want("voici-messages", ctx.origin, ctx.pageId, f.from, ctx.now, att.expiresAt)).valueOrNull() ?: return no("bad-delegation")
        val ts = VoiciMessages.parseVoiciThreadStatement(c["threadStmt"])
        val threadSig = str(c["threadSig"])
        if (ts == null || ts.pageId != ctx.pageId || ts.pseudonymPub != f.from || threadSig == null ||
            !WebEnvelopes.ed25519VerifyHex(threadSig, VoiciMessages.canonicalVoiciThreadStatement(ts), f.from)) return no("bad-thread")
        if (f.conv != VoiciMessages.voiciConv(ctx.pageId, f.from)) return no("wrong-conv")
        if (checkSdp(f.sdp, f.media ?: MEDIA_AUDIO) != null) return no("bad-sdp")
        try { PqHybrid.parseHybridSealPublicKey(WebEnvelopes.hexToBytes(f.xpub)) } catch (_: Exception) { return no("bad-key") }
        if (!WebEnvelopes.p256VerifyP1363(f.sig, f.bytes(), del.delegatePub)) return no("bad-signature")
        if (!ctx.skipFresh && Math.abs(f.at - ctx.now) > SKEW_MS) return no("stale")
        if (ctx.allowed != null && !ctx.allowed.invoke(f.o)) return no("not-allowed")
        return VoiciOutcome.Ok(VoiciCallRequest(f.pageId, f.conv, f.callId, f.from, f.xpub, f.sdp, f.at, del.delegatePub, f.o, f.media ?: MEDIA_AUDIO))
    }

    // ── per-call keys ──

    /** The answering phone's encapsulation to the caller's per-call key (eseed: 64 random bytes). */
    fun encapsulate(callerXwingPub: ByteArray, eseed: ByteArray = ByteArray(PqHybrid.HYBRID_SEAL_RANDOMNESS_LEN).also { SecureRandom().nextBytes(it) }): Pair<ByteArray, ByteArray> {
        val pk = PqHybrid.parseHybridSealPublicKey(callerXwingPub)
        require(eseed.size == PqHybrid.HYBRID_SEAL_RANDOMNESS_LEN) { "voici-call: randomness" }
        return PqHybrid.xwingEncapsulate(pk, eseed)
    }

    fun decapsulate(ciphertext: ByteArray, callerSeed: ByteArray): ByteArray {
        require(ciphertext.size == PqHybrid.HYBRID_SEAL_ENC_LEN) { "voici-call: ciphertext" }
        return PqHybrid.xwingDecapsulate(ciphertext, callerSeed)
    }

    private fun hkdf(ikm: ByteArray, salt: ByteArray, info: String): ByteArray {
        val g = HKDFBytesGenerator(SHA256Digest())
        g.init(HKDFParameters(ikm, salt, VoiciJs.utf8(info)))
        return ByteArray(32).also { g.generateBytes(it, 0, 32) }
    }

    fun frameKeys(sharedSecret: ByteArray, requestBytes: ByteArray, answerBytes: ByteArray): Pair<ByteArray, ByteArray> {
        val th = VoiciJs.sha256(requestBytes + answerBytes)
        return hkdf(sharedSecret, th, "$TAG_FRAME|c2p") to hkdf(sharedSecret, th, "$TAG_FRAME|p2c")
    }

    /** The video keys (voici-calls-v2.md §1.5): their own directional keys from the same secret. */
    fun videoFrameKeys(sharedSecret: ByteArray, requestBytes: ByteArray, answerBytes: ByteArray): Pair<ByteArray, ByteArray> {
        val th = VoiciJs.sha256(requestBytes + answerBytes)
        return hkdf(sharedSecret, th, "$TAG_FRAME|c2p|video") to hkdf(sharedSecret, th, "$TAG_FRAME|p2c|video")
    }

    fun nextFrameKey(k: ByteArray): ByteArray = hkdf(k, ByteArray(0), "$TAG_FRAME|next")

    fun epoch(ctr: Long): Long = ctr / FRAMES_PER_EPOCH

    // ── frames ──

    private fun be64(n: Long) = ByteArray(8) { ((n ushr (8 * (7 - it))) and 0xff).toByte() }
    private fun nonce(dir: VoiciCallDir, ctr: Long) = byteArrayOf(0, 0, 0, dir.code.toByte()) + be64(ctr)
    private fun aad(callId: String, dir: VoiciCallDir, ctr: Long) = VoiciJs.utf8("$callId|${dir.name}|$ctr")
    internal fun readCtr(sealed: ByteArray): Long = (0 until 8).fold(0L) { acc, i -> (acc shl 8) or (sealed[i].toLong() and 0xff) }

    fun sealFrame(key: ByteArray, callId: String, dir: VoiciCallDir, ctr: Long, frame: ByteArray): ByteArray {
        require(frame.size <= FRAME_MAX) { "voici-call: frame too long" }
        require(ctr in 0 until MAX_CTR) { "voici-call: counter" }
        val pt = ByteArray(FRAME_PLAINTEXT)
        pt[0] = frame.size.toByte()
        frame.copyInto(pt, 1)
        return be64(ctr) + VoiciJs.gcmEncrypt(key, nonce(dir, ctr), aad(callId, dir, ctr), pt)
    }

    fun openFrame(key: ByteArray, callId: String, dir: VoiciCallDir, sealed: ByteArray): Pair<Long, ByteArray>? {
        if (sealed.size != SEALED_FRAME) return null
        val ctr = readCtr(sealed)
        if (ctr < 0 || ctr >= MAX_CTR) return null
        val pt = try {
            VoiciJs.gcmDecrypt(key, nonce(dir, ctr), aad(callId, dir, ctr), sealed.copyOfRange(8, sealed.size))
        } catch (_: Exception) {
            return null
        }
        val len = pt[0].toInt() and 0xff
        if (len > FRAME_MAX) return null
        for (i in 1 + len until pt.size) if (pt[i] != 0.toByte()) return null
        return ctr to pt.copyOfRange(1, 1 + len)
    }

    // ── video frames (voici-calls-v2.md §1.5, §1.6) ──

    /** The VP8 payload header that stays clear: 10 bytes on a key frame (bit 0 of byte 0 clear), else 3. */
    fun videoClearLen(frame: ByteArray): Int = if (frame.isEmpty()) 0 else if ((frame[0].toInt() and 1) == 0) 10 else 3

    fun videoBucket(n: Int): Int? = VIDEO_BUCKETS.firstOrNull { it >= n }

    private const val VIDEO_OVERHEAD = 8 + 4 + 16
    private fun videoAad(callId: String, dir: VoiciCallDir, ctr: Long, clear: ByteArray) = VoiciJs.utf8("$callId|${dir.name}|video|$ctr|") + clear
    private fun be32(n: Int) = ByteArray(4) { ((n ushr (8 * (3 - it))) and 0xff).toByte() }

    fun sealVideoFrame(key: ByteArray, callId: String, dir: VoiciCallDir, ctr: Long, frame: ByteArray): ByteArray {
        require(ctr in 0 until MAX_CTR) { "voici-call: counter" }
        val c = videoClearLen(frame)
        require(c > 0 && frame.size >= c) { "voici-call: video frame too short" }
        val clear = frame.copyOfRange(0, c)
        val bodyLen = frame.size - c
        val total = videoBucket(c + VIDEO_OVERHEAD + bodyLen) ?: throw IllegalArgumentException("voici-call: video frame too long")
        val pt = ByteArray(total - c - 8 - 16)
        be32(bodyLen).copyInto(pt, 0)
        frame.copyInto(pt, 4, c, frame.size)
        return clear + be64(ctr) + VoiciJs.gcmEncrypt(key, nonce(dir, ctr), videoAad(callId, dir, ctr, clear), pt)
    }

    internal fun videoCtr(sealed: ByteArray): Long? {
        if (sealed.size !in VIDEO_BUCKETS) return null
        val c = videoClearLen(sealed)
        if (c == 0 || sealed.size < c + VIDEO_OVERHEAD) return null
        return (c until c + 8).fold(0L) { acc, i -> (acc shl 8) or (sealed[i].toLong() and 0xff) }
    }

    fun openVideoFrame(key: ByteArray, callId: String, dir: VoiciCallDir, sealed: ByteArray): Pair<Long, ByteArray>? {
        val ctr = videoCtr(sealed) ?: return null
        if (ctr < 0 || ctr >= MAX_CTR) return null
        val c = videoClearLen(sealed)
        val clear = sealed.copyOfRange(0, c)
        val pt = try {
            VoiciJs.gcmDecrypt(key, nonce(dir, ctr), videoAad(callId, dir, ctr, clear), sealed.copyOfRange(c + 8, sealed.size))
        } catch (_: Exception) {
            return null
        }
        val len = (0 until 4).fold(0L) { acc, i -> (acc shl 8) or (pt[i].toLong() and 0xff) }
        if (len > pt.size - 4) return null
        val end = 4 + len.toInt()
        for (i in end until pt.size) if (pt[i] != 0.toByte()) return null
        return ctr to (clear + pt.copyOfRange(4, end))
    }

    // ── answer ──

    fun canonicalAnswer(a: VoiciCallAnswerBody): ByteArray {
        if (!(hex(a.callId, 16) && hex(a.deviceRef, 32) && hex(a.requestHash, 32) && hex(a.xwingCiphertext, PqHybrid.HYBRID_SEAL_ENC_LEN) &&
            hex(a.turnUser, 16) && hex(a.turnSecret, 32) && isTime(a.issuedAt) && (a.media == null || a.media in MEDIA_VALUES))) badField(TAG_ANSWER)
        val parts = mutableListOf<Any>(TAG_ANSWER, a.callId, a.deviceRef, a.requestHash, a.xwingCiphertext, sdpHash(a.answerSdp), a.turnUser, WebEnvelopes.sha256Hex(a.turnSecret), a.issuedAt)
        if (a.media != null) parts.add(a.media)
        return join(*parts.toTypedArray())
    }

    /** The wire answer, signed by the page's owner messages signing key. */
    fun signAnswer(a: VoiciCallAnswerBody, ownerSignSeed: ByteArray): JsonObject {
        val sig = VoiciJs.hex(VoiciJs.edSign(ownerSignSeed, canonicalAnswer(a)))
        val m = linkedMapOf<String, JsonElement>(
            "v" to JsonPrimitive(1), "kind" to JsonPrimitive("voici-call-answer"), "callId" to JsonPrimitive(a.callId),
            "deviceRef" to JsonPrimitive(a.deviceRef), "requestHash" to JsonPrimitive(a.requestHash), "xwingCiphertext" to JsonPrimitive(a.xwingCiphertext),
            "answerSdp" to JsonPrimitive(a.answerSdp), "turnUser" to JsonPrimitive(a.turnUser), "turnSecret" to JsonPrimitive(a.turnSecret),
            "issuedAt" to JsonPrimitive(a.issuedAt), "sig" to JsonPrimitive(sig),
        )
        if (a.media != null) m["media"] = JsonPrimitive(a.media)
        return JsonObject(m)
    }

    private val ANSWER_KEYS = listOf("v", "kind", "callId", "deviceRef", "requestHash", "xwingCiphertext", "answerSdp", "turnUser", "turnSecret", "issuedAt", "sig")

    fun parseAnswer(v: JsonElement?): Pair<VoiciCallAnswerBody, String>? {
        val o = VoiciJs.obj(v) ?: return null
        if (!(VoiciJs.exactKeys(o, ANSWER_KEYS) || VoiciJs.exactKeys(o, ANSWER_KEYS + "media")) || !VoiciJs.isNumEq(o["v"], 1) || str(o["kind"]) != "voici-call-answer") return null
        val media = if (o.containsKey("media")) (str(o["media"]) ?: return null) else null
        val sig = str(o["sig"]).takeIf { hex(it, 64) } ?: return null
        val b = VoiciCallAnswerBody(str(o["callId"]) ?: return null, str(o["deviceRef"]) ?: return null, str(o["requestHash"]) ?: return null,
            str(o["xwingCiphertext"]) ?: return null, str(o["answerSdp"]) ?: return null, str(o["turnUser"]) ?: return null,
            str(o["turnSecret"]) ?: return null, VoiciJs.time(o["issuedAt"]) ?: return null, media)
        return try { canonicalAnswer(b); b to sig } catch (_: IllegalArgumentException) { null }
    }

    fun checkAnswer(v: JsonElement?, request: JsonElement, ownerSignPub: String, now: Long? = null): VoiciOutcome<VoiciCallAnswerBody> {
        val (a, sig) = parseAnswer(v) ?: return no("malformed")
        val ro = VoiciJs.obj(request) ?: return no("malformed")
        val rBytes = requestBytes(request) ?: return no("malformed")
        if (a.callId != str(ro["callId"])) return no("wrong-call")
        if (a.requestHash != WebEnvelopes.sha256Hex(rBytes)) return no("wrong-request")
        val reqMedia = str(ro["media"]) ?: MEDIA_AUDIO
        if (a.media == MEDIA_VIDEO && reqMedia != MEDIA_VIDEO) return no("bad-sdp")
        if (checkSdp(a.answerSdp, reqMedia) != null) return no("bad-sdp")
        if (!WebEnvelopes.ed25519VerifyHex(sig, canonicalAnswer(a), ownerSignPub)) return no("bad-signature")
        if (now != null && Math.abs(a.issuedAt - now) > SKEW_MS) return no("stale")
        return VoiciOutcome.Ok(a)
    }

    // ── receipt ──

    fun canonicalReceipt(account: String, callId: String, deviceRef: String, issuedAt: Long, expiresAt: Long): ByteArray {
        if (!(USERNAME.matches(account) && hex(callId, 16) && hex(deviceRef, 32) && isTime(issuedAt) && isTime(expiresAt) && expiresAt > issuedAt)) badField(TAG_RECEIPT)
        return join(TAG_RECEIPT, account, callId, deviceRef, issuedAt, expiresAt)
    }

    fun checkReceipt(v: JsonElement?, caKeys: Collection<String>, now: Long, account: String, deviceRef: String? = null): VoiciOutcome<JsonObject> {
        val o = VoiciJs.obj(v) ?: return no("malformed")
        if (!VoiciJs.exactKeys(o, listOf("v", "kind", "account", "callId", "deviceRef", "issuedAt", "expiresAt", "signedBy", "signature")) ||
            !VoiciJs.isNumEq(o["v"], 1) || str(o["kind"]) != "voici-call-receipt") return no("malformed")
        val signedBy = str(o["signedBy"]).takeIf { hex(it, 32) } ?: return no("malformed")
        val sig = str(o["signature"]).takeIf { hex(it, 64) } ?: return no("malformed")
        val acct = str(o["account"]) ?: return no("malformed")
        val dref = str(o["deviceRef"]) ?: return no("malformed")
        val at = VoiciJs.time(o["issuedAt"]) ?: return no("malformed")
        val exp = VoiciJs.time(o["expiresAt"]) ?: return no("malformed")
        val bytes = try { canonicalReceipt(acct, str(o["callId"]) ?: return no("malformed"), dref, at, exp) } catch (_: IllegalArgumentException) { return no("malformed") }
        if (signedBy !in caKeys) return no("unknown-ca")
        if (!WebEnvelopes.ed25519VerifyHex(sig, bytes, signedBy)) return no("bad-signature")
        if (exp - at > RECEIPT_TTL_MS) return no("too-long")
        if (acct != account) return no("wrong-account")
        if (deviceRef != null && dref != deviceRef) return no("wrong-device")
        if (now < at - SKEW_MS) return no("not-yet-valid")
        if (now >= exp) return no("expired")
        return VoiciOutcome.Ok(o)
    }

    // ── end, allow ──

    fun canonicalEnd(callId: String, side: String, reason: String, issuedAt: Long): ByteArray {
        if (!(hex(callId, 16) && (side == "caller" || side == "owner") && reason in END_REASONS && isTime(issuedAt))) badField(TAG_END)
        return join(TAG_END, callId, side, reason, issuedAt)
    }

    fun signEndOwner(callId: String, reason: String, issuedAt: Long, ownerSignSeed: ByteArray): JsonObject {
        val sig = VoiciJs.hex(VoiciJs.edSign(ownerSignSeed, canonicalEnd(callId, "owner", reason, issuedAt)))
        return JsonObject(mapOf("v" to JsonPrimitive(1), "kind" to JsonPrimitive("voici-call-end"), "callId" to JsonPrimitive(callId),
            "side" to JsonPrimitive("owner"), "reason" to JsonPrimitive(reason), "issuedAt" to JsonPrimitive(issuedAt), "sig" to JsonPrimitive(sig)))
    }

    /** The caller's end order, signed by the browser-like delegate key B (P-256, P1363): this app placing a call. */
    fun signEndCaller(callId: String, reason: String, issuedAt: Long, delegatePriv: ByteArray): JsonObject {
        val sig = VoiciJs.hex(VoiciJs.p256Sign(delegatePriv, canonicalEnd(callId, "caller", reason, issuedAt)))
        return JsonObject(mapOf("v" to JsonPrimitive(1), "kind" to JsonPrimitive("voici-call-end"), "callId" to JsonPrimitive(callId),
            "side" to JsonPrimitive("caller"), "reason" to JsonPrimitive(reason), "issuedAt" to JsonPrimitive(issuedAt), "sig" to JsonPrimitive(sig)))
    }

    /** An end order for [callId]: the caller's under B (P-256), the owner's under ownerSignPub. Returns its reason. */
    fun checkEnd(v: JsonElement?, callId: String, callerPub: String, ownerSignPub: String): String? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("v", "kind", "callId", "side", "reason", "issuedAt", "sig")) || !VoiciJs.isNumEq(o["v"], 1) || str(o["kind"]) != "voici-call-end") return null
        val sig = str(o["sig"]) ?: return null
        val side = str(o["side"]) ?: return null
        val reason = str(o["reason"]) ?: return null
        val cid = str(o["callId"]) ?: return null
        val bytes = try { canonicalEnd(cid, side, reason, VoiciJs.time(o["issuedAt"]) ?: return null) } catch (_: IllegalArgumentException) { return null }
        if (cid != callId) return null
        val ok = if (side == "caller") WebEnvelopes.p256VerifyP1363(sig, bytes, callerPub) else WebEnvelopes.ed25519VerifyHex(sig, bytes, ownerSignPub)
        return if (ok) reason else null
    }

    fun canonicalAllow(pageId: String, conv: String, op: String, issuedAt: Long): ByteArray {
        if (!(PAGE_ID.matches(pageId) && hex(conv, 32) && (op == "allow" || op == "disallow") && isTime(issuedAt))) badField(TAG_ALLOW)
        return join(TAG_ALLOW, pageId, conv, op, issuedAt)
    }

    fun signAllow(pageId: String, conv: String, op: String, issuedAt: Long, ownerSignSeed: ByteArray): String =
        VoiciJs.hex(VoiciJs.edSign(ownerSignSeed, canonicalAllow(pageId, conv, op, issuedAt)))

    fun verifyAllow(pageId: String, conv: String, op: String, issuedAt: Long, signature: String, ownerSignPub: String): Boolean = try {
        WebEnvelopes.ed25519VerifyHex(signature, canonicalAllow(pageId, conv, op, issuedAt), ownerSignPub)
    } catch (_: Exception) {
        false
    }

    /** The allow order's body as `.com` reads it: `{pageId, conv, op, issuedAt}`. */
    fun allowJson(pageId: String, conv: String, op: String, issuedAt: Long): kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.buildJsonObject {
        put("pageId", kotlinx.serialization.json.JsonPrimitive(pageId))
        put("conv", kotlinx.serialization.json.JsonPrimitive(conv))
        put("op", kotlinx.serialization.json.JsonPrimitive(op))
        put("issuedAt", kotlinx.serialization.json.JsonPrimitive(issuedAt))
    }

    // ── call key (answering while locked; docs/voici-calls.md, owner decisions 2026-11-15) ──

    const val TAG_CALL_KEY = "flagship/voici-call-key/v1"
    const val TAG_CALL_KEY_REVOKE = "flagship/voici-call-key-revoke/v1"
    const val TAG_CALL_JOIN = "flagship/voici-call-join/v1"
    private val DEVICE_ID = Regex("^[0-9a-f]{32}$")
    private val BINDING_KEYS = listOf("username", "deviceId", "callKeyPub", "createdAt")

    /** A SEC1 uncompressed P-256 point, lowercase hex. */
    fun isCallKeyPub(pub: String?): Boolean {
        if (pub == null || !hex(pub, 65) || !pub.startsWith("04")) return false
        return VoiciJs.isP256Point(WebEnvelopes.hexToBytes(pub))
    }

    fun canonicalCallKeyBinding(username: String, deviceId: String, callKeyPub: String, createdAt: Long): ByteArray {
        if (!(USERNAME.matches(username) && DEVICE_ID.matches(deviceId) && isCallKeyPub(callKeyPub) && isTime(createdAt))) badField(TAG_CALL_KEY)
        return join(TAG_CALL_KEY, username, deviceId, callKeyPub, createdAt)
    }

    /** `{binding:{username, deviceId, callKeyPub, createdAt}, signature}`, signed by the page's owner messages key. */
    fun signCallKeyBinding(username: String, deviceId: String, callKeyPub: String, createdAt: Long, ownerSignSeed: ByteArray): JsonObject {
        val sig = VoiciJs.hex(VoiciJs.edSign(ownerSignSeed, canonicalCallKeyBinding(username, deviceId, callKeyPub, createdAt)))
        return JsonObject(linkedMapOf(
            "binding" to JsonObject(linkedMapOf("username" to JsonPrimitive(username), "deviceId" to JsonPrimitive(deviceId),
                "callKeyPub" to JsonPrimitive(callKeyPub), "createdAt" to JsonPrimitive(createdAt))),
            "signature" to JsonPrimitive(sig),
        ))
    }

    fun verifyCallKeyBinding(proof: JsonElement?, ownerSignPub: String, username: String): Boolean {
        val p = VoiciJs.obj(proof) ?: return false
        if (!VoiciJs.exactKeys(p, listOf("binding", "signature"))) return false
        val b = VoiciJs.obj(p["binding"]) ?: return false
        if (!VoiciJs.exactKeys(b, BINDING_KEYS)) return false
        val sig = str(p["signature"]).takeIf { hex(it, 64) } ?: return false
        if (str(b["username"]) != username) return false
        val bytes = try {
            canonicalCallKeyBinding(username, str(b["deviceId"]) ?: return false, str(b["callKeyPub"]) ?: return false, VoiciJs.time(b["createdAt"]) ?: return false)
        } catch (_: IllegalArgumentException) { return false }
        return WebEnvelopes.ed25519VerifyHex(sig, bytes, ownerSignPub)
    }

    fun canonicalCallKeyRevoke(username: String, deviceId: String, callKeyPub: String, revokedAt: Long): ByteArray {
        if (!(USERNAME.matches(username) && DEVICE_ID.matches(deviceId) && isCallKeyPub(callKeyPub) && isTime(revokedAt))) badField(TAG_CALL_KEY_REVOKE)
        return join(TAG_CALL_KEY_REVOKE, username, deviceId, callKeyPub, revokedAt)
    }

    /** A revocation under the owner key (Ed25519) or the revoked call key itself (P-256). */
    fun verifyCallKeyRevoke(username: String, deviceId: String, callKeyPub: String, revokedAt: Long, signature: String, ownerSignPub: String): Boolean {
        val bytes = try { canonicalCallKeyRevoke(username, deviceId, callKeyPub, revokedAt) } catch (_: IllegalArgumentException) { return false }
        return WebEnvelopes.ed25519VerifyHex(signature, bytes, ownerSignPub) || WebEnvelopes.p256VerifyP1363(signature, bytes, callKeyPub)
    }

    fun revokeJson(username: String, deviceId: String, callKeyPub: String, revokedAt: Long): JsonObject = JsonObject(linkedMapOf(
        "username" to JsonPrimitive(username), "deviceId" to JsonPrimitive(deviceId), "callKeyPub" to JsonPrimitive(callKeyPub), "revokedAt" to JsonPrimitive(revokedAt),
    ))

    fun canonicalCallJoin(username: String, callId: String, deviceId: String, callKeyPub: String, issuedAt: Long): ByteArray {
        if (!(USERNAME.matches(username) && hex(callId, 16) && DEVICE_ID.matches(deviceId) && isCallKeyPub(callKeyPub) && isTime(issuedAt))) badField(TAG_CALL_JOIN)
        return join(TAG_CALL_JOIN, username, callId, deviceId, callKeyPub, issuedAt)
    }

    fun verifyCallJoin(username: String, callId: String, deviceId: String, callKeyPub: String, issuedAt: Long, signature: String, now: Long): Boolean {
        if (Math.abs(issuedAt - now) > SKEW_MS) return false
        val bytes = try { canonicalCallJoin(username, callId, deviceId, callKeyPub, issuedAt) } catch (_: IllegalArgumentException) { return false }
        return WebEnvelopes.p256VerifyP1363(signature, bytes, callKeyPub)
    }

    /** The answer signed by a bound call key: [sign] returns the IEEE P1363 (r‖s) P-256 signature of the bytes. */
    fun signAnswerWithCallKey(a: VoiciCallAnswerBody, proof: JsonObject, sign: (ByteArray) -> ByteArray): JsonObject {
        val sig = sign(canonicalAnswer(a))
        require(sig.size == 64) { "$TAG_ANSWER: bad call-key signature" }
        val m = LinkedHashMap(signAnswerShape(a))
        m["sig"] = JsonPrimitive(VoiciJs.hex(sig))
        m["callKey"] = proof
        return JsonObject(m)
    }

    private fun signAnswerShape(a: VoiciCallAnswerBody): Map<String, JsonElement> {
        val m = linkedMapOf<String, JsonElement>(
            "v" to JsonPrimitive(1), "kind" to JsonPrimitive("voici-call-answer"), "callId" to JsonPrimitive(a.callId),
            "deviceRef" to JsonPrimitive(a.deviceRef), "requestHash" to JsonPrimitive(a.requestHash), "xwingCiphertext" to JsonPrimitive(a.xwingCiphertext),
            "answerSdp" to JsonPrimitive(a.answerSdp), "turnUser" to JsonPrimitive(a.turnUser), "turnSecret" to JsonPrimitive(a.turnSecret),
            "issuedAt" to JsonPrimitive(a.issuedAt),
        )
        if (a.media != null) m["media"] = JsonPrimitive(a.media)
        return m
    }

    /** The owner's end order signed by the call key that answered. */
    fun signEndOwnerWithCallKey(callId: String, reason: String, issuedAt: Long, sign: (ByteArray) -> ByteArray): JsonObject {
        val sig = sign(canonicalEnd(callId, "owner", reason, issuedAt))
        require(sig.size == 64) { "$TAG_END: bad call-key signature" }
        return JsonObject(mapOf("v" to JsonPrimitive(1), "kind" to JsonPrimitive("voici-call-end"), "callId" to JsonPrimitive(callId),
            "side" to JsonPrimitive("owner"), "reason" to JsonPrimitive(reason), "issuedAt" to JsonPrimitive(issuedAt), "sig" to JsonPrimitive(VoiciJs.hex(sig))))
    }

    // ── push, missed call ──

    private fun openCanonical(seed: ByteArray, purpose: String, callId: String, sealed: ByteArray): JsonObject? = try {
        val pt = PqHybrid.hybridOpen(seed, purpose, listOf(VoiciJs.utf8(callId)), sealed).plaintext
        val text = VoiciJs.utf8Fatal(pt)
        val v = text?.let { VoiciJs.parseJson(it) }
        if (v != null && WebEnvelopes.canonicalJson(v) == text) VoiciJs.obj(v) else null
    } catch (_: Exception) {
        null
    }

    /** The push's sealed caller: (pageId, conv, from), only for [callId] and a matching conv. */
    fun openPush(inboxSeed: ByteArray, callId: String, sealed: ByteArray): Triple<String, String, String>? {
        val o = openCanonical(inboxSeed, TAG_PUSH, callId, sealed) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("v", "callId", "pageId", "conv", "from")) || !VoiciJs.isNumEq(o["v"], 1) || str(o["callId"]) != callId) return null
        val pageId = str(o["pageId"])?.takeIf { PAGE_ID.matches(it) } ?: return null
        val conv = str(o["conv"])?.takeIf { hex(it, 32) } ?: return null
        val from = str(o["from"])?.takeIf { hex(it, 32) } ?: return null
        if (VoiciMessages.voiciConv(pageId, from) != conv) return null
        return Triple(pageId, conv, from)
    }

    /** Opens a missed call from the mailbox and checks its request's signatures (no clock check). */
    fun openMissedCall(inboxSeed: ByteArray, callId: String, sealed: ByteArray, pageId: String, origin: String, caKeys: Collection<String>): VoiciMissedCall? {
        val o = openCanonical(inboxSeed, TAG_MISSED_CALL, callId, sealed) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("v", "request", "ringingAt", "endedAt", "reason")) || !VoiciJs.isNumEq(o["v"], 1)) return null
        val ringing = VoiciJs.time(o["ringingAt"]) ?: return null
        val ended = VoiciJs.time(o["endedAt"])?.takeIf { it >= ringing } ?: return null
        val reason = str(o["reason"])?.takeIf { it in MISSED_REASONS } ?: return null
        val r = checkAnyRequest(o["request"], VoiciCallRequestCheckContext(pageId, true, origin, caKeys, ringing, skipFresh = true), VoiciCallModes.FROM_ANYONE).valueOrNull() ?: return null
        if (r.callId != callId) return null
        return VoiciMissedCall(r, ringing, ended, reason)
    }
}

/** The sending half of one direction of a call: a counter from 0 and the current epoch key. */
class VoiciCallFrameSender(baseKey: ByteArray, private val callId: String, private val dir: VoiciCallDir, private val video: Boolean = false) {
    private var ctr = 0L
    private var epoch = 0L
    private var key = baseKey.copyOf()

    fun seal(frame: ByteArray): ByteArray {
        val e = VoiciCalls.epoch(ctr)
        while (epoch < e) {
            val next = VoiciCalls.nextFrameKey(key)
            key.fill(0)
            key = next
            epoch++
        }
        return if (video) VoiciCalls.sealVideoFrame(key, callId, dir, ctr++, frame) else VoiciCalls.sealFrame(key, callId, dir, ctr++, frame)
    }
}

/** The receiving half: a 128-frame replay window, a 3,000-frame gap limit, the newest two epochs' keys only. */
class VoiciCallFrameReceiver(baseKey: ByteArray, private val callId: String, private val dir: VoiciCallDir, private val video: Boolean = false) {
    private var highest = -1L
    private val seen = HashSet<Long>()
    private val keys = HashMap<Long, ByteArray>().apply { put(0L, baseKey.copyOf()) }
    private var top = 0L

    fun open(sealed: ByteArray): ByteArray? {
        val ctr = (if (video) VoiciCalls.videoCtr(sealed) else if (sealed.size == VoiciCalls.SEALED_FRAME) VoiciCalls.readCtr(sealed) else null) ?: return null
        if (ctr < 0 || ctr >= VoiciCalls.MAX_CTR || ctr > highest + VoiciCalls.MAX_GAP_FRAMES) return null
        if (ctr <= highest - VoiciCalls.REPLAY_WINDOW || ctr in seen) return null
        val e = VoiciCalls.epoch(ctr)
        if (e < top - 1) return null
        val pending = ArrayList<ByteArray>()
        var k = keys[e]
        if (e > top) {
            var cur = keys[top]!!
            for (i in top until e) { cur = VoiciCalls.nextFrameKey(cur); pending.add(cur) }
            k = cur
        }
        val opened = k?.let { if (video) VoiciCalls.openVideoFrame(it, callId, dir, sealed) else VoiciCalls.openFrame(it, callId, dir, sealed) }
        if (opened == null) {
            pending.forEach { it.fill(0) }
            return null
        }
        for (p in pending) keys[++top] = p
        keys.keys.filter { it < top - 1 }.forEach { keys.remove(it)?.fill(0) }
        if (ctr > highest) highest = ctr
        seen.add(ctr)
        seen.removeAll { it <= highest - VoiciCalls.REPLAY_WINDOW }
        return opened.second
    }
}
