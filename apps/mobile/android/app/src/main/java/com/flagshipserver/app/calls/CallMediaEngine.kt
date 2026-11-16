// The media half of a voi.ci call (docs/voici-calls.md §3, §4; voici-calls-v2.md §1): WebRTC answering the caller's
// offer over the phone's own TURN responder, every encoded frame sealed again by [CallFrameCrypto] under the call's
// X-Wing keys. The signalling (VoiciCallSession) and the Telecom layer depend only on this interface, so the WebRTC
// library is one implementation behind it. None is bundled yet (the libwebrtc build is an open owner decision, see
// docs/voici-calls.md "Open items"): [StubCallMediaEngine] refuses to answer, and the call ends with its sentence.

package com.flagshipserver.app.calls

import com.flagshipserver.app.core.voici.VoiciCallDir
import com.flagshipserver.app.core.voici.VoiciCallFrameReceiver
import com.flagshipserver.app.core.voici.VoiciCallFrameSender

/** The answering phone's one-time TURN credential (the answer carries it to the caller). */
data class CallTurnCredential(val user: String, val secret: String)

/**
 * The frame layer of one call on the answering phone: it sends p2c and receives c2p, audio and video on their own
 * keys and counters. A WebRTC FrameEncryptor / FrameDecryptor calls [sealAudio] / [openAudio] (and the video pair)
 * for every encoded frame; a frame that fails to open is dropped, never decoded.
 */
class CallFrameCrypto(callId: String, audio: Pair<ByteArray, ByteArray>, video: Pair<ByteArray, ByteArray>?, private val caller: Boolean = false) {
    // [audio] and [video] are (c2p, p2c). The answering phone sends p2c; this app placing a call (caller) sends c2p.
    private val outDir = if (caller) VoiciCallDir.c2p else VoiciCallDir.p2c
    private val inDir = if (caller) VoiciCallDir.p2c else VoiciCallDir.c2p
    private fun out(k: Pair<ByteArray, ByteArray>) = if (caller) k.first else k.second
    private fun inn(k: Pair<ByteArray, ByteArray>) = if (caller) k.second else k.first
    private val audioOut = VoiciCallFrameSender(out(audio), callId, outDir)
    private val audioIn = VoiciCallFrameReceiver(inn(audio), callId, inDir)
    private val videoOut = video?.let { VoiciCallFrameSender(out(it), callId, outDir, video = true) }
    private val videoIn = video?.let { VoiciCallFrameReceiver(inn(it), callId, inDir, video = true) }

    @Synchronized fun sealAudio(frame: ByteArray): ByteArray? = runCatching { audioOut.seal(frame) }.getOrNull()
    @Synchronized fun openAudio(sealed: ByteArray): ByteArray? = audioIn.open(sealed)
    @Synchronized fun sealVideo(frame: ByteArray): ByteArray? = videoOut?.let { o -> runCatching { o.seal(frame) }.getOrNull() }
    @Synchronized fun openVideo(sealed: ByteArray): ByteArray? = videoIn?.open(sealed)
    val hasVideo: Boolean get() = videoOut != null
}

class CallMediaUnavailable : Exception("call media unavailable")

/** The callee's phone as this app's only ICE server when it places a call: TURN over TLS on its bare name. */
data class CallerIceServer(val url: String, val username: String, val credential: String)

interface CallMediaEngine {
    /** Applies the caller's (checked) offer and returns this phone's answer SDP, before munging. */
    suspend fun answer(offerSdp: String, video: Boolean, turn: CallTurnCredential): String
    /** The keys arrived (the room said this device won): media may flow. */
    fun start(crypto: CallFrameCrypto)
    fun addRemoteIce(candidate: String?)
    var onLocalIce: ((String?) -> Unit)?
    var onConnected: (() -> Unit)?
    var onFailed: (() -> Unit)?
    fun setMuted(muted: Boolean)
    /** Turns this phone's camera on or off; false when it can't (no video section, no camera). */
    fun setCamera(on: Boolean): Boolean
    fun stop()

    // ── Calling from the app (docs/voici-calls.md "Calling from the app"): this phone is the caller. The defaults say
    // "no media engine", so the app hands the call to a voi.ci tab; an engine that can place calls overrides them.

    /** Makes this phone's offer (audio, plus a video section when [video]), before munging. Nothing is gathered yet. */
    suspend fun offer(video: Boolean): String = throw CallMediaUnavailable()
    /** Applies the callee's checked answer with its phone as the only ICE server (relay only); then ICE may start. */
    suspend fun applyAnswer(sdp: String, iceServer: CallerIceServer): Unit = throw CallMediaUnavailable()
    /** The answer checked out: media may flow under these (caller-direction) keys. */
    fun startCaller(crypto: CallFrameCrypto) {}
}

/** No WebRTC library in this build: every answer is refused, so a call can ring but never connects. */
class StubCallMediaEngine : CallMediaEngine {
    override suspend fun answer(offerSdp: String, video: Boolean, turn: CallTurnCredential): String = throw CallMediaUnavailable()
    override fun start(crypto: CallFrameCrypto) {}
    override fun addRemoteIce(candidate: String?) {}
    override var onLocalIce: ((String?) -> Unit)? = null
    override var onConnected: (() -> Unit)? = null
    override var onFailed: (() -> Unit)? = null
    override fun setMuted(muted: Boolean) {}
    override fun setCamera(on: Boolean): Boolean = false
    override fun stop() {}
}
