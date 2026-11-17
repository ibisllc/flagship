// Calling from the app (docs/voici-calls.md "Calling from the app"): this account calls a page it signed in to, as
// that page's visitor. Same protocol as a voi.ci tab: the app makes its own session for the page (its pseudonym
// there, `.com`'s attestation of it, a delegation to a P-256 key made for this one call, the thread statement), signs
// the call request with that key, and runs the caller's side of the room. Media goes through CallMediaEngine's caller
// methods; when this build has no engine (or it fails to start), the call is handed to a voi.ci tab in the system
// browser over /qr-pipe instead (VoiciCallHandoff), and the browser places it with its own WebRTC.
//
// The callee's page decides as for any visitor: calls on, who may call, its block list; Do Not Disturb is theirs.

package com.flagshipserver.app.calls

import com.flagshipserver.app.api.VoiciHttpError
import com.flagshipserver.app.core.Base64URL
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.PairingSocket
import com.flagshipserver.app.core.asTerminalError
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.core.voici.VoiciCallHandoff
import com.flagshipserver.app.core.voici.VoiciCallHandoffSealed
import com.flagshipserver.app.core.voici.VoiciCalls
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciIntegrity
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciKeyring
import com.flagshipserver.app.core.voici.VoiciMessages
import com.flagshipserver.app.core.voici.VoiciOutcome
import com.flagshipserver.app.core.voici.VoiciOwner
import com.flagshipserver.app.core.voici.VoiciPage
import com.flagshipserver.app.core.voici.VoiciSignInRequest
import com.flagshipserver.app.core.voici.VoiciVisitorAttestation
import com.flagshipserver.app.core.voici.VoiciVisitorKeys
import com.flagshipserver.app.core.voici.WebEnvelopes
import com.google.crypto.tink.subtle.X25519
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.math.BigInteger
import java.net.URLEncoder
import java.security.SecureRandom

/** A page this account can call: its username and pageId (from a sign-in to it). */
data class VoiciCallTarget(val username: String, val pageId: String)

sealed interface VoiciOutgoingState {
    data object Preparing : VoiciOutgoingState
    data object Ringing : VoiciOutgoingState
    data object Connecting : VoiciOutgoingState
    data class Connected(val since: Long) : VoiciOutgoingState
    /** The call went to a voi.ci tab in the browser (no media engine here). */
    data object Browser : VoiciOutgoingState
    /** A room reason: hangup, cancel, decline, busy, no-answer, limit, failed. */
    data class Ended(val reason: String) : VoiciOutgoingState
    /** A refusal or failure code (VoiciCopy.callFailure makes the sentence). */
    data class Failed(val code: String, val retryAfterSec: Long? = null) : VoiciOutgoingState
}

/** The caller's room WebSocket (`<room>?t=<token>`). The live one is the pinning factory's OkHttp client. */
interface VoiciCallerRoom {
    fun connect(url: String, onMessage: (String) -> Unit, onClosed: () -> Unit)
    fun send(text: String)
    fun close()
}

class LiveVoiciCallerRoom(private val http: OkHttpClient) : VoiciCallerRoom {
    private var ws: WebSocket? = null
    override fun connect(url: String, onMessage: (String) -> Unit, onClosed: () -> Unit) {
        ws = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = onMessage(text)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onClosed()
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onClosed()
        })
    }
    override fun send(text: String) {
        ws?.send(text)
    }
    override fun close() {
        runCatching { ws?.close(1000, null) }
        ws = null
    }
}

/** The app's half of the browser handoff: join /qr-pipe/<sid> as `phone`, open the browser, deliver once it is there. */
interface VoiciCallHandoffPipe {
    suspend fun deliver(sid: String, sealed: VoiciCallHandoffSealed, openBrowser: () -> Unit)
}

class LiveVoiciCallHandoffPipe(
    private val http: OkHttpClient,
    private val host: () -> String = { Endpoints.controlHost },
    private val secure: () -> Boolean = { Endpoints.controlBaseUrl.startsWith("https") },
) : VoiciCallHandoffPipe {
    override suspend fun deliver(sid: String, sealed: VoiciCallHandoffSealed, openBrowser: () -> Unit) {
        val sock = PairingSocket(http, "${if (secure()) "wss" else "ws"}://${host()}/qr-pipe/${URLEncoder.encode(sid, "UTF-8")}?role=phone")
        try {
            sock.open()
            openBrowser()
            // The tab joins as `browser` once it has loaded: until then the relay answers our hello with peer-missing.
            withTimeout(60_000) {
                while (true) {
                    sock.send {
                        put("kind", "hello")
                        put("phonePk", sealed.phonePk)
                    }
                    val f = sock.next()
                    if (f.kind == "ack") break
                    if (f.kind == "peer-missing") {
                        delay(500)
                        continue
                    }
                    f.asTerminalError()?.let { throw it }
                }
                sock.send {
                    put("kind", "deliver")
                    put("ciphertext", sealed.ciphertext)
                    put("nonce", sealed.nonce)
                }
                while (true) {
                    val f = sock.next()
                    if (f.kind == "delivered") return@withTimeout
                    f.asTerminalError()?.let { throw it }
                }
            }
        } finally {
            sock.close()
        }
    }
}

class VoiciOutgoingCall(
    val target: VoiciCallTarget,
    val video: Boolean,
    private val center: VoiciCenter,
    private val keyring: VoiciKeyring,
    private val integrity: VoiciIntegrity,
    private val engine: CallMediaEngine,
    private val room: VoiciCallerRoom,
    private val handoff: VoiciCallHandoffPipe,
    private val openBrowser: (String) -> Unit,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val origin: () -> String = { Endpoints.voiciOrigin },
    private val apex: () -> String = { Endpoints.controlHost },
    private val servicesHost: (String) -> String = { Endpoints.userZoneHost(it) },
    /** "Call and allow call-back": attach this conversation's ring-back channel before the call (the owner can ring back). */
    val allowCallBack: Boolean = false,
) {
    private val rng = SecureRandom()
    private val _state = MutableStateFlow<VoiciOutgoingState>(VoiciOutgoingState.Preparing)
    val state: StateFlow<VoiciOutgoingState> = _state.asStateFlow()

    @Volatile private var callId: String? = null
    @Volatile private var request: JsonObject? = null
    @Volatile private var delegatePriv: ByteArray? = null
    @Volatile private var callerSeed: ByteArray? = null
    @Volatile private var ownerSignPub: String = ""
    @Volatile private var connectedAt: Long? = null
    @Volatile private var over = false
    /** The other side's camera: "on", "off" or "paused". */
    val remoteCamera = MutableStateFlow("off")
    /** The call screen's switches: our microphone, our camera, and which camera. */
    val muted = MutableStateFlow(false)
    val cameraOn = MutableStateFlow(false)
    val cameraFront = MutableStateFlow(true)
    /** The call's media engine, for the call screen's video pictures. */
    val media: CallMediaEngine get() = engine

    private fun randHex(n: Int) = VoiciJs.hex(ByteArray(n).also(rng::nextBytes))

    /** A P-256 scalar in [1, n-1]. */
    private fun newDelegateKey(): ByteArray {
        val n = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
        while (true) {
            val b = ByteArray(32).also(rng::nextBytes)
            val v = BigInteger(1, b)
            if (v.signum() > 0 && v < n) return b
        }
    }

    /** Places the call; returns once it rings, went to the browser, or failed. */
    suspend fun start() {
        try {
            place()
        } catch (e: VoiciHttpError) {
            fail(e.code ?: "unavailable", e.retryAfterSec)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            fail("unavailable")
        }
    }

    private suspend fun place() {
        val u = keyring.username() ?: return fail("locked")
        val umk = keyring.umk() ?: return fail("locked")
        val device = keyring.device() ?: return fail("locked")
        val keys = center.accountKeys(target.username) ?: return fail("not-found")
        val idx = VoiciPage.checkVoiciPageIndex(center.client.page(target.username) ?: return fail("not-found"), target.username, keys.sensitiveKind, keys.sensitivePub, pageId = target.pageId)
            .valueOrNull() ?: return fail("not-found")
        if (!idx.body.takesCalls) return fail("calls-off")
        ownerSignPub = idx.body.ownerSignPub
        val visitor = VoiciVisitorKeys.derive(umk, target.pageId)
        val t = now()
        val att = VoiciVisitorAttestation.obtain(center, u, device, integrity, visitor, t) ?: return fail("bad-attestation")
        // The pseudonymous side always dials out; allowing a call-back only tells `.com` this conversation may ring this
        // account's phones (said in the pop-up). The owner still never learns who calls.
        if (allowCallBack) center.setCallBack(target.pageId, true)?.let { return fail(it) }
        val priv = newDelegateKey()
        delegatePriv = priv
        val req = VoiciSignInRequest(origin(), target.pageId, target.username, VoiciJs.hex(VoiciJs.p256PublicKey(priv)), randHex(16))
        val session = VoiciOwner.signInAnswer(req, visitor, att.toJson(), att.expiresAt, t, maxLifetimeMs = VoiciCallHandoff.SESSION_MS)
        val offer = try {
            engine.offer(video)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            // No media engine in this build, or it couldn't start: the browser places the call.
            return handToBrowser(session, priv)
        }
        val media = if (video) VoiciCalls.MEDIA_VIDEO else null
        val sdp = VoiciCalls.mungeSdp(offer)
        if (VoiciCalls.checkSdp(sdp, media ?: VoiciCalls.MEDIA_AUDIO) != null) return fail("unavailable")
        val id = randHex(16)
        callId = id
        val seed = ByteArray(32).also(rng::nextBytes)
        callerSeed = seed
        val xpub = VoiciJs.hex(PqHybrid.hybridSealKeygen(seed).publicKey)
        val conv = VoiciMessages.voiciConv(target.pageId, visitor.pseudonymPub)
        val sig = VoiciJs.hex(VoiciJs.p256Sign(priv, VoiciCalls.canonicalRequest(target.pageId, conv, id, xpub, sdp, t, media)))
        val cred = JsonObject(listOf("attestation", "delegation", "delegationSig", "threadStmt", "threadSig").associateWith { session[it]!! })
        val fields = linkedMapOf<String, JsonElement>(
            "v" to JsonPrimitive(1), "kind" to JsonPrimitive("voici-call-request"), "pageId" to JsonPrimitive(target.pageId), "conv" to JsonPrimitive(conv),
            "callId" to JsonPrimitive(id), "from" to JsonPrimitive(visitor.pseudonymPub), "callerXwingPub" to JsonPrimitive(xpub), "offerSdp" to JsonPrimitive(sdp),
            "issuedAt" to JsonPrimitive(t), "cred" to cred, "sig" to JsonPrimitive(sig),
        )
        if (media != null) fields["media"] = JsonPrimitive(media)
        val r = JsonObject(fields)
        request = r
        val placed = center.client.placeCall(r)
        if (placed.callId != id || placed.room != "wss://${apex()}/api/voici/calls/$id/caller" || !Regex("^[0-9a-f]{64}$").matches(placed.token)) return fail("unavailable")
        engine.onLocalIce = { c -> send(JsonObject(mapOf("t" to JsonPrimitive("ice"), "candidate" to (c?.let { JsonPrimitive(it) } ?: JsonNull)))) }
        engine.onConnected = {
            connectedAt = now()
            _state.value = VoiciOutgoingState.Connected(connectedAt!!)
        }
        engine.onFailed = { end("failed") }
        _state.value = VoiciOutgoingState.Ringing
        room.connect("${placed.room}?t=${placed.token}", ::onRoom) {
            if (!over) {
                val s = _state.value
                if (s is VoiciOutgoingState.Ringing || s is VoiciOutgoingState.Preparing) end("failed") else if (s !is VoiciOutgoingState.Connected) end("failed")
            }
        }
    }

    private suspend fun handToBrowser(session: JsonObject, priv: ByteArray) {
        val t = now()
        val ho = VoiciCallHandoff.build(target.username, target.pageId, if (video) VoiciCalls.MEDIA_VIDEO else VoiciCalls.MEDIA_AUDIO, t, t + VoiciCallHandoff.TTL_MS, priv, session)
        val browserSecret = X25519.generatePrivateKey()
        val appSecret = X25519.generatePrivateKey()
        val sid = Base64URL.encode(ByteArray(16).also(rng::nextBytes))
        val link = VoiciCallHandoff.link(VoiciCallHandoff.host(origin()), target.username, sid, browserSecret)
        val sealed = VoiciCallHandoff.seal(ho, appSecret, browserSecret, ByteArray(12).also(rng::nextBytes))
        appSecret.fill(0)
        priv.fill(0)
        try {
            handoff.deliver(sid, sealed) { openBrowser(link) }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            return fail("browser-unreachable")
        } finally {
            browserSecret.fill(0)
        }
        over = true
        _state.value = VoiciOutgoingState.Browser
        record("browser", 0)
    }

    private fun send(o: JsonObject) = room.send(o.toString())

    private fun onRoom(text: String) {
        val m = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
        when ((m["t"] as? JsonPrimitive)?.contentOrNull) {
            "ringing" -> if (_state.value is VoiciOutgoingState.Preparing) _state.value = VoiciOutgoingState.Ringing
            "connecting" -> {}
            "answer" -> scope.launch { onAnswer(m["answer"]) }
            "ice" -> engine.addRemoteIce((m["candidate"] as? JsonPrimitive)?.takeIf { it.isString }?.content)
            "camera" -> (m["state"] as? JsonPrimitive)?.contentOrNull?.takeIf { it in VoiciCalls.CAMERA_STATES }?.let { remoteCamera.value = it }
            "ended" -> end((m["reason"] as? JsonPrimitive)?.contentOrNull?.takeIf { it in VoiciCalls.END_REASONS } ?: "hangup")
        }
    }

    /** The callee's answer: signed by the page's owner key over this request, then the frame keys and the media. */
    internal suspend fun onAnswer(raw: JsonElement?) {
        val r = request ?: return
        val id = callId ?: return
        val seed = callerSeed ?: return
        val a = when (val c = VoiciCalls.checkAnswer(raw, r, ownerSignPub, now())) {
            is VoiciOutcome.Ok -> c.value
            is VoiciOutcome.Refused -> return hangUpWith("failed")
        }
        if (VoiciCalls.sdpFingerprint(a.answerSdp) == null) return hangUpWith("failed")
        _state.value = VoiciOutgoingState.Connecting
        val ss = runCatching { VoiciCalls.decapsulate(WebEnvelopes.hexToBytes(a.xwingCiphertext), seed) }.getOrElse { return hangUpWith("failed") }
        seed.fill(0)
        callerSeed = null
        val reqBytes = VoiciCalls.requestBytes(r) ?: return hangUpWith("failed")
        val ansBytes = VoiciCalls.canonicalAnswer(a)
        val audio = VoiciCalls.frameKeys(ss, reqBytes, ansBytes)
        val vk = if (r["media"] != null) VoiciCalls.videoFrameKeys(ss, reqBytes, ansBytes) else null
        ss.fill(0)
        try {
            engine.applyAnswer(a.answerSdp, CallerIceServer("turns:${servicesHost(target.username)}:443?transport=tcp", a.turnUser, a.turnSecret))
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            return hangUpWith("failed")
        }
        engine.startCaller(CallFrameCrypto(id, audio, vk, caller = true))
    }

    private fun hangUpWith(reason: String) {
        val id = callId
        val priv = delegatePriv
        if (id != null && priv != null) runCatching { send(JsonObject(mapOf("t" to JsonPrimitive("end"), "end" to VoiciCalls.signEndCaller(id, reason, now(), priv)))) }
        end(reason)
    }

    /** Hang up, or cancel while it rings: a signed caller end order, then the room closes. */
    fun hangUp() {
        val s = _state.value
        if (s is VoiciOutgoingState.Ended || s is VoiciOutgoingState.Failed || s is VoiciOutgoingState.Browser) return
        hangUpWith(if (s is VoiciOutgoingState.Connected || s is VoiciOutgoingState.Connecting) "hangup" else "cancel")
    }

    fun setMuted(muted: Boolean) {
        engine.setMuted(muted)
        this.muted.value = muted
    }

    fun setCamera(on: Boolean): Boolean {
        if (!video || engine.setCamera(on).not()) return false
        send(JsonObject(mapOf("t" to JsonPrimitive("camera"), "state" to JsonPrimitive(if (on) "on" else "off"))))
        if (on && !cameraOn.value) cameraFront.value = true
        cameraOn.value = on
        return true
    }

    /** Front or back camera while ours runs. */
    fun flipCamera() {
        if (!cameraOn.value || !engine.flipCamera()) return
        cameraFront.value = !cameraFront.value
    }

    @Synchronized private fun end(reason: String) {
        if (over) return
        over = true
        val at = connectedAt
        engine.stop()
        room.close()
        delegatePriv?.fill(0)
        delegatePriv = null
        callerSeed?.fill(0)
        callerSeed = null
        cameraOn.value = false
        _state.value = VoiciOutgoingState.Ended(reason)
        record(VoiciCallHistory.outgoingOutcome(reason, at != null), if (at != null) now() - at else 0)
    }

    @Synchronized private fun fail(code: String, retryAfterSec: Long? = null) {
        if (over) return
        over = true
        engine.stop()
        room.close()
        delegatePriv?.fill(0)
        _state.value = VoiciOutgoingState.Failed(code, retryAfterSec)
        record("failed", 0)
    }

    private fun record(outcome: String, durationMs: Long) {
        val rec = VoiciCallRecord(
            id = randHex(16), callId = callId ?: "", direction = "out", outcome = outcome,
            peerUsername = target.username, peerPageId = target.pageId, media = if (video) VoiciCalls.MEDIA_VIDEO else VoiciCalls.MEDIA_AUDIO,
            at = now() - durationMs, durationMs = durationMs,
        )
        scope.launch { runCatching { center.recordCall(rec) } }
    }
}
