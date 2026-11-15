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

/** What a call needs from this device's keys (VoiciCenter.callKeys). */
class VoiciCallKeys(
    val username: String,
    val device: VoiciDeviceSigner,
    val pageId: String,
    val acceptsCalls: Boolean,
    val ownerSignSeed: ByteArray,
    val ownerSignPub: String,
    /** The page's inbox seeds, newest epoch first (a push sealed before a rotation still opens). */
    val inboxSeeds: List<ByteArray>,
    val caKeys: List<String>,
    val origin: String,
    val blocked: Set<String>,
    val revoked: Set<String>,
    val nicknames: Map<String, String>,
) {
    val deviceRef: String get() = VoiciCalls.deviceRef(device.pubHex)

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
        val d = keys.device
        val sig = d.signer.sign(AccountMetadata.canonicalDirectoryRequest(keys.username, d.deviceId, d.pubHex, "GET", path, requestId, at))
        val req = Request.Builder()
            .url("wss://${push.room}$path?u=${keys.username}")
            .header("x-flagship-device-id", d.deviceId)
            .header("x-flagship-device-pub", d.pubHex)
            .header("x-flagship-request-id", requestId)
            .header("x-flagship-issued-at", at.toString())
            .header("x-flagship-signature", HexUtil.encode(sig))
            .build()
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
        when (val r = VoiciCalls.checkRequest(raw, ctx)) {
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
        val signed = VoiciCalls.signAnswer(body, keys.ownerSignSeed)
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

    /** Hang up an answered call: the end order is signed by the owner messages key. */
    fun hangUp() {
        scope.launch {
            val order = VoiciCalls.signEndOwner(push.callId, "hangup", now(), keys.ownerSignSeed)
            send(JsonObject(mapOf("t" to JsonPrimitive("end"), "end" to order)))
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
