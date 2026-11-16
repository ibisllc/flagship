// One ringing voi.ci call on this admin device (docs/voici-calls.md §1, §2, §6): the room WebSocket to `.com`
// (device headers signed over `GET /api/voici/calls/<callId>/device`), the caller's signed request checked here before
// anything rings past the generic notice, the signed answer (X-Wing encapsulation, the one-time TURN credential, the
// munged answer SDP, `media` when the caller offered video), the CA receipt that says this device won, and the frame
// keys handed to the media engine. Every check and signature is the shared VoiciCalls port; nothing is reimplemented.

package com.flagshipserver.app.calls

import com.flagshipserver.app.core.AccountMetadata
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.voici.VoiciCallAnswerBody
import com.flagshipserver.app.core.voici.VoiciCallRequest
import com.flagshipserver.app.core.voici.VoiciCallRequestCheckContext
import com.flagshipserver.app.core.voici.VoiciCalls
import com.flagshipserver.app.core.voici.VoiciOutcome
import com.flagshipserver.app.push.VoiciCallPush
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.security.SecureRandom

/**
 * What a call needs from this device's keys (VoiciCenter.callKeys). Unlocked, it signs with the account device key and
 * the owner messages key; locked (the setting "Answer calls while Flagship is locked"), only [callKey] signs, and
 * nothing else of the account is at hand: no inbox key (the caller is "Someone on voi.ci"), no local block list
 * (`.com` refuses blocked callers before it rings).
 */
class VoiciCallKeys(
    val username: String,
    val device: VoiciDeviceSigner?,
    val pageId: String,
    val acceptsCalls: Boolean,
    val ownerSignSeed: ByteArray?,
    val ownerSignPub: String,
    /** The page's inbox seeds, newest epoch first (a push sealed before a rotation still opens). */
    val inboxSeeds: List<ByteArray>,
    val caKeys: List<String>,
    val origin: String,
    val blocked: Set<String>,
    val revoked: Set<String>,
    val nicknames: Map<String, String>,
    val callKey: VoiciCallKey? = null,
    /** The page's "who can call" (an "anyone" page also takes anonymous requests); locked, `.com`'s check stands. */
    val callsFrom: String = com.flagshipserver.app.core.voici.VoiciCallModes.FROM_ANYONE,
) {
    val deviceRef: String get() = callKey?.deviceRef ?: VoiciCalls.deviceRef(device!!.pubHex)

    fun signAnswer(body: VoiciCallAnswerBody): JsonObject =
        callKey?.let { k -> VoiciCalls.signAnswerWithCallKey(body, k.proof) { k.signer.sign(it) } } ?: VoiciCalls.signAnswer(body, ownerSignSeed!!)

    fun signEnd(callId: String, reason: String, at: Long): JsonObject? =
        callKey?.let { k -> runCatching { VoiciCalls.signEndOwnerWithCallKey(callId, reason, at) { k.signer.sign(it) } }.getOrNull() }
            ?: ownerSignSeed?.let { VoiciCalls.signEndOwner(callId, reason, at, it) }

    companion object {
        /** What a locked device has: its call key and the public facts kept with it. */
        fun locked(k: VoiciCallKey, caKeys: List<String>, origin: String) = VoiciCallKeys(
            username = k.username, device = null, pageId = k.pageId, acceptsCalls = true, ownerSignSeed = null, ownerSignPub = k.ownerSignPub,
            inboxSeeds = emptyList(), caKeys = caKeys, origin = origin, blocked = emptySet(), revoked = emptySet(), nicknames = emptyMap(), callKey = k,
        )
    }

    /** The caller in a push, opened under the inbox keys: (pageId, conv, pseudonymPub) or null. */
    fun openPush(callId: String, sealed: ByteArray): Triple<String, String, String>? =
        inboxSeeds.firstNotNullOfOrNull { VoiciCalls.openPush(it, callId, sealed) }
}

class VoiciCallSession(
    val push: VoiciCallPush.Payload,
    private val keys: VoiciCallKeys,
    private val media: CallMediaEngine,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val listener: Listener,
    private val now: () -> Long = System::currentTimeMillis,
) {
    interface Listener {
        /** The room's request passed every check: the call may be answered. */
        fun onRequest(request: VoiciCallRequest)
        /** The room said this device's answer won (receipt checked) and the frame keys are with the media engine. */
        fun onWon()
        fun onConnected()
        /** The call is over here: a room reason (hangup, cancel, no-answer, limit, ...), "answered-elsewhere" or "failed". */
        fun onEnded(reason: String)
        /** The caller's camera: "on", "off" or "paused" (voici-calls-v2.md §1.4). */
        fun onRemoteCamera(state: String)
    }

    private val rng = SecureRandom()
    private var ws: WebSocket? = null
    @Volatile var request: VoiciCallRequest? = null
        private set
    private var pending: Triple<ByteArray, ByteArray, ByteArray>? = null
    @Volatile private var over = false

    private fun randHex(n: Int) = HexUtil.encode(ByteArray(n).also(rng::nextBytes))

    fun connect() {
        val path = "/api/voici/calls/${push.callId}/device"
        val requestId = randHex(16)
        val at = now()
        val b = Request.Builder().url("wss://${push.room}$path?u=${keys.username}")
        val k = keys.callKey
        val d = keys.device
        if (k != null) {
            // Locked: the call key's join (flagship/voici-call-join/v1) instead of device headers.
            k.joinHeaders(push.callId, at).forEach { (h, v) -> b.header(h, v) }
        } else if (d != null) {
            val sig = d.signer.sign(AccountMetadata.canonicalDirectoryRequest(keys.username, d.deviceId, d.pubHex, "GET", path, requestId, at))
            b.header("x-flagship-device-id", d.deviceId)
                .header("x-flagship-device-pub", d.pubHex)
                .header("x-flagship-request-id", requestId)
                .header("x-flagship-issued-at", at.toString())
                .header("x-flagship-signature", HexUtil.encode(sig))
        } else {
            return end("failed")
        }
        val req = b.build()
        media.onLocalIce = { c -> send(JsonObject(mapOf("t" to JsonPrimitive("ice"), "candidate" to (c?.let { JsonPrimitive(it) } ?: JsonNull)))) }
        media.onConnected = { listener.onConnected() }
        media.onFailed = { end("failed") }
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = onRoom(text)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = end("failed")
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = end("failed")
        })
    }

    private fun send(o: JsonObject) {
        ws?.send(o.toString())
    }

    private fun onRoom(text: String) {
        val m = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
        when ((m["t"] as? JsonPrimitive)?.contentOrNull) {
            "request" -> onRequest(m["request"])
            "won" -> onWon(m["receipt"])
            "answered-elsewhere" -> end("answered-elsewhere")
            "ice" -> media.addRemoteIce((m["candidate"] as? JsonPrimitive)?.takeIf { it.isString }?.content)
            "camera" -> (m["state"] as? JsonPrimitive)?.contentOrNull?.takeIf { it in VoiciCalls.CAMERA_STATES }?.let(listener::onRemoteCamera)
            "ended" -> end((m["reason"] as? JsonPrimitive)?.contentOrNull ?: "hangup")
            "error" -> end("failed")
        }
    }

    private fun onRequest(raw: JsonElement?) {
        val ctx = VoiciCallRequestCheckContext(
            pageId = keys.pageId, acceptsCalls = keys.acceptsCalls, origin = keys.origin, caKeys = keys.caKeys, now = now(),
            blocked = keys.blocked, revoked = keys.revoked,
        )
        when (val r = VoiciCalls.checkAnyRequest(raw, ctx, keys.callsFrom)) {
            is VoiciOutcome.Ok -> {
                if (r.value.callId != push.callId) return end("failed")
                request = r.value
                listener.onRequest(r.value)
            }
            is VoiciOutcome.Refused -> end("failed")
        }
    }

    /**
     * Answers: [cameraAble] says this phone can send video (it has a camera); the call itself starts as audio.
     * Returns null once the signed answer is sent, else a code: "not-ready", "media-unavailable", "failed".
     */
    suspend fun answer(cameraAble: Boolean): String? {
        val r = request ?: return "not-ready"
        val turn = CallTurnCredential(randHex(16), randHex(32))
        val xpub = HexUtil.decode(r.callerXwingPub) ?: return "failed"
        val (ct, ss) = runCatching { VoiciCalls.encapsulate(xpub) }.getOrElse { return "failed" }
        val sdp = try {
            VoiciCalls.mungeSdp(media.answer(r.offerSdp, r.hasVideo, turn))
        } catch (_: CallMediaUnavailable) {
            ss.fill(0)
            return "media-unavailable"
        } catch (_: Exception) {
            ss.fill(0)
            return "failed"
        }
        if (VoiciCalls.checkSdp(sdp, r.media) != null) {
            ss.fill(0)
            return "failed"
        }
        val reqBytes = VoiciCalls.requestBytes(r.json) ?: return "failed"
        val requestHash = VoiciCalls.requestHash(r.json) ?: return "failed"
        val body = VoiciCallAnswerBody(
            callId = r.callId, deviceRef = keys.deviceRef, requestHash = requestHash,
            xwingCiphertext = HexUtil.encode(ct), answerSdp = sdp, turnUser = turn.user, turnSecret = turn.secret, issuedAt = now(),
            media = if (r.hasVideo) (if (cameraAble) VoiciCalls.MEDIA_VIDEO else VoiciCalls.MEDIA_AUDIO) else null,
        )
        val signed = runCatching { keys.signAnswer(body) }.getOrElse { ss.fill(0); return "failed" }
        pending = Triple(ss, reqBytes, VoiciCalls.canonicalAnswer(body))
        // The caller's TURN stream may reach this device's bare name only for this answer's one-time credential.
        com.flagshipserver.app.phoneroute.CallTurnGate.arm(com.flagshipserver.app.phoneroute.CallTurnGate.Credential(turn.user, turn.secret))
        send(JsonObject(mapOf("t" to JsonPrimitive("answer"), "answer" to signed)))
        return null
    }

    private fun onWon(receipt: JsonElement?) {
        val p = pending ?: return end("failed")
        if (VoiciCalls.checkReceipt(receipt, keys.caKeys, now(), keys.username, keys.deviceRef) !is VoiciOutcome.Ok) return end("failed")
        val (ss, reqBytes, ansBytes) = p
        val audio = VoiciCalls.frameKeys(ss, reqBytes, ansBytes)
        val video = if (request?.hasVideo == true) VoiciCalls.videoFrameKeys(ss, reqBytes, ansBytes) else null
        ss.fill(0)
        pending = null
        media.start(CallFrameCrypto(push.callId, audio, video))
        listener.onWon()
    }

    /** "Decline" while ringing: the room ends the call for every device and records a missed call. */
    fun decline() {
        send(JsonObject(mapOf("t" to JsonPrimitive("decline"))))
        end("decline")
    }

    /** Hang up an answered call: the end order is signed by the owner messages key, or the call key that answered. */
    fun hangUp() {
        scope.launch {
            keys.signEnd(push.callId, "hangup", now())?.let { order -> send(JsonObject(mapOf("t" to JsonPrimitive("end"), "end" to order))) }
            end("hangup")
        }
    }

    /** Leaves the room without ending the call for the other devices (this device couldn't answer). */
    fun leave() = end("left")

    fun sendCamera(state: String) {
        if (state in VoiciCalls.CAMERA_STATES) send(JsonObject(mapOf("t" to JsonPrimitive("camera"), "state" to JsonPrimitive(state))))
    }

    @Synchronized private fun end(reason: String) {
        if (over) return
        over = true
        com.flagshipserver.app.phoneroute.CallTurnGate.disarm()
        pending?.first?.fill(0)
        pending = null
        media.stop()
        runCatching { ws?.close(1000, null) }
        listener.onEnded(reason)
    }
}
