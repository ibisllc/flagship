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
class CallFrameCrypto(callId: String, audio: Pair<ByteArray, ByteArray>, video: Pair<ByteArray, ByteArray>?) {
    private val audioOut = VoiciCallFrameSender(audio.second, callId, VoiciCallDir.p2c)
    private val audioIn = VoiciCallFrameReceiver(audio.first, callId, VoiciCallDir.c2p)
    private val videoOut = video?.let { VoiciCallFrameSender(it.second, callId, VoiciCallDir.p2c, video = true) }
    private val videoIn = video?.let { VoiciCallFrameReceiver(it.first, callId, VoiciCallDir.c2p, video = true) }

    @Synchronized fun sealAudio(frame: ByteArray): ByteArray? = runCatching { audioOut.seal(frame) }.getOrNull()
    @Synchronized fun openAudio(sealed: ByteArray): ByteArray? = audioIn.open(sealed)
    @Synchronized fun sealVideo(frame: ByteArray): ByteArray? = videoOut?.let { o -> runCatching { o.seal(frame) }.getOrNull() }
    @Synchronized fun openVideo(sealed: ByteArray): ByteArray? = videoIn?.open(sealed)
    val hasVideo: Boolean get() = videoOut != null
}

class CallMediaUnavailable : Exception("call media unavailable")

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
