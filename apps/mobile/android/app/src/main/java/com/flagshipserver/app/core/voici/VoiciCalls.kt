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
)

data class VoiciCallAnswerBody(
    val callId: String,
    val deviceRef: String,
    val requestHash: String,
    val xwingCiphertext: String,
    val answerSdp: String,
    val turnUser: String,
    val turnSecret: String,
    val issuedAt: Long,
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
    fun checkSdp(sdp: String): String? {
        if (VoiciJs.utf8(sdp).size > MAX_SDP_BYTES) return "too-large"
        val ls = lines(sdp)
        val media = ls.filter { it.startsWith("m=") }
        if (media.size != 1 || !media[0].startsWith("m=audio ")) return "not-audio-only"
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
        val out = ArrayList<String>()
        var inAudio = false
        for (l in ls) {
            if (l.startsWith("m=")) {
                inAudio = l.startsWith("m=audio ")
                if (inAudio) {
                    out.add((l.split(" ").take(3) + pt).joinToString(" "))
                    continue
                }
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

    fun canonicalRequest(pageId: String, conv: String, callId: String, callerXwingPub: String, offerSdp: String, issuedAt: Long): ByteArray {
        if (!(PAGE_ID.matches(pageId) && hex(conv, 32) && hex(callId, 16) && hex(callerXwingPub, PqHybrid.HYBRID_SEAL_PUBLIC_KEY_LEN) && isTime(issuedAt))) badField(TAG_REQUEST)
        return join(TAG_REQUEST, pageId, conv, callId, callerXwingPub, sdpHash(offerSdp), issuedAt)
    }

    private val REQUEST_KEYS = listOf("v", "kind", "pageId", "conv", "callId", "from", "callerXwingPub", "offerSdp", "issuedAt", "cred", "sig")

    private class Fields(val o: JsonObject, val pageId: String, val conv: String, val callId: String, val from: String, val xpub: String, val sdp: String, val at: Long, val sig: String, val cred: JsonObject) {
        fun bytes() = canonicalRequest(pageId, conv, callId, xpub, sdp, at)
    }

    private fun fields(v: JsonElement?): Fields? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, REQUEST_KEYS) || !VoiciJs.isNumEq(o["v"], 1) || str(o["kind"]) != "voici-call-request") return null
        val sig = str(o["sig"]).takeIf { hex(it, 64) } ?: return null
        val cred = VoiciJs.obj(o["cred"]) ?: return null
        val from = str(o["from"]).takeIf { hex(it, 32) } ?: return null
        val f = Fields(o, str(o["pageId"]) ?: return null, str(o["conv"]) ?: return null, str(o["callId"]) ?: return null, from,
            str(o["callerXwingPub"]) ?: return null, str(o["offerSdp"]) ?: return null, VoiciJs.time(o["issuedAt"]) ?: return null, sig, cred)
        return try { f.bytes(); f } catch (_: IllegalArgumentException) { null }
    }

    fun requestHash(request: JsonElement): String? = fields(request)?.let { WebEnvelopes.sha256Hex(it.bytes()) }

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
        if (checkSdp(f.sdp) != null) return no("bad-sdp")
        try { PqHybrid.parseHybridSealPublicKey(WebEnvelopes.hexToBytes(f.xpub)) } catch (_: Exception) { return no("bad-key") }
        if (!WebEnvelopes.p256VerifyP1363(f.sig, f.bytes(), del.delegatePub)) return no("bad-signature")
        if (!ctx.skipFresh && Math.abs(f.at - ctx.now) > SKEW_MS) return no("stale")
        if (ctx.allowed != null && !ctx.allowed.invoke(f.o)) return no("not-allowed")
        return VoiciOutcome.Ok(VoiciCallRequest(f.pageId, f.conv, f.callId, f.from, f.xpub, f.sdp, f.at, del.delegatePub, f.o))
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

    // ── answer ──

    fun canonicalAnswer(a: VoiciCallAnswerBody): ByteArray {
        if (!(hex(a.callId, 16) && hex(a.deviceRef, 32) && hex(a.requestHash, 32) && hex(a.xwingCiphertext, PqHybrid.HYBRID_SEAL_ENC_LEN) &&
            hex(a.turnUser, 16) && hex(a.turnSecret, 32) && isTime(a.issuedAt))) badField(TAG_ANSWER)
        return join(TAG_ANSWER, a.callId, a.deviceRef, a.requestHash, a.xwingCiphertext, sdpHash(a.answerSdp), a.turnUser, WebEnvelopes.sha256Hex(a.turnSecret), a.issuedAt)
    }

    /** The wire answer, signed by the page's owner messages signing key. */
    fun signAnswer(a: VoiciCallAnswerBody, ownerSignSeed: ByteArray): JsonObject {
        val sig = VoiciJs.hex(VoiciJs.edSign(ownerSignSeed, canonicalAnswer(a)))
        return JsonObject(mapOf(
            "v" to JsonPrimitive(1), "kind" to JsonPrimitive("voici-call-answer"), "callId" to JsonPrimitive(a.callId),
            "deviceRef" to JsonPrimitive(a.deviceRef), "requestHash" to JsonPrimitive(a.requestHash), "xwingCiphertext" to JsonPrimitive(a.xwingCiphertext),
            "answerSdp" to JsonPrimitive(a.answerSdp), "turnUser" to JsonPrimitive(a.turnUser), "turnSecret" to JsonPrimitive(a.turnSecret),
            "issuedAt" to JsonPrimitive(a.issuedAt), "sig" to JsonPrimitive(sig),
        ))
    }

    private val ANSWER_KEYS = listOf("v", "kind", "callId", "deviceRef", "requestHash", "xwingCiphertext", "answerSdp", "turnUser", "turnSecret", "issuedAt", "sig")

    fun parseAnswer(v: JsonElement?): Pair<VoiciCallAnswerBody, String>? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, ANSWER_KEYS) || !VoiciJs.isNumEq(o["v"], 1) || str(o["kind"]) != "voici-call-answer") return null
        val sig = str(o["sig"]).takeIf { hex(it, 64) } ?: return null
        val b = VoiciCallAnswerBody(str(o["callId"]) ?: return null, str(o["deviceRef"]) ?: return null, str(o["requestHash"]) ?: return null,
            str(o["xwingCiphertext"]) ?: return null, str(o["answerSdp"]) ?: return null, str(o["turnUser"]) ?: return null,
            str(o["turnSecret"]) ?: return null, VoiciJs.time(o["issuedAt"]) ?: return null)
        return try { canonicalAnswer(b); b to sig } catch (_: IllegalArgumentException) { null }
    }

    fun checkAnswer(v: JsonElement?, request: JsonElement, ownerSignPub: String, now: Long? = null): VoiciOutcome<VoiciCallAnswerBody> {
        val (a, sig) = parseAnswer(v) ?: return no("malformed")
        val rf = fields(request) ?: return no("malformed")
        if (a.callId != rf.callId) return no("wrong-call")
        if (a.requestHash != WebEnvelopes.sha256Hex(rf.bytes())) return no("wrong-request")
        if (checkSdp(a.answerSdp) != null) return no("bad-sdp")
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
        val r = checkRequest(o["request"], VoiciCallRequestCheckContext(pageId, true, origin, caKeys, ringing, skipFresh = true)).valueOrNull() ?: return null
        if (r.callId != callId) return null
        return VoiciMissedCall(r, ringing, ended, reason)
    }
}

/** The sending half of one direction of a call: a counter from 0 and the current epoch key. */
class VoiciCallFrameSender(baseKey: ByteArray, private val callId: String, private val dir: VoiciCallDir) {
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
        return VoiciCalls.sealFrame(key, callId, dir, ctr++, frame)
    }
}

/** The receiving half: a 128-frame replay window, a 3,000-frame gap limit, the newest two epochs' keys only. */
class VoiciCallFrameReceiver(baseKey: ByteArray, private val callId: String, private val dir: VoiciCallDir) {
    private var highest = -1L
    private val seen = HashSet<Long>()
    private val keys = HashMap<Long, ByteArray>().apply { put(0L, baseKey.copyOf()) }
    private var top = 0L

    fun open(sealed: ByteArray): ByteArray? {
        if (sealed.size != VoiciCalls.SEALED_FRAME) return null
        val ctr = VoiciCalls.readCtr(sealed)
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
        val opened = k?.let { VoiciCalls.openFrame(it, callId, dir, sealed) }
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
