// The real media half of a voi.ci call on Android (docs/voici-calls.md §3, §4; voici-calls-v2.md §1): our libwebrtc
// build answering the caller's offer. The phone's peer connection gathers one loopback host candidate; the caller
// reaches it through this phone's own TURN responder ([TurnResponder], armed by VoiciCallSession through
// CallTurnGate). Every encoded frame goes through FlagshipFrameCrypto (the tools/libwebrtc overlay) into
// [CallFrameCrypto]: until the keys arrive, and after stop, every frame is dropped. Same shape as iOS
// WebRTCCallMediaEngine.swift.
//
// The same engine places calls (docs/voici-calls.md "Calling from the app"): [offer] makes this phone's offer before
// the request is signed (nothing is gathered yet), [applyAnswer] sets the callee's phone as the only ICE server
// (TURN over TLS on its bare name, relay only) and applies the munged offer exactly as signed, then the answer, and
// [startCaller] hands over the caller-direction frame keys (sends c2p, receives p2c).

package com.flagshipserver.app.calls

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import com.flagshipserver.app.phoneroute.CallTurnGate
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.FlagshipFrameCrypto
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class WebRtcCallMediaEngine(private val context: Context) : CallMediaEngine {
    override var onLocalIce: ((String?) -> Unit)? = null
    override var onConnected: (() -> Unit)? = null
    override var onFailed: (() -> Unit)? = null
    @Volatile private var onPathOpen: (() -> Unit)? = null
    override fun setOnPathOpen(f: () -> Unit) { onPathOpen = f }

    private val lock = Any()
    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var pc: PeerConnection? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var videoTransceiver: RtpTransceiver? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var capturer: CameraVideoCapturer? = null
    private var textures: SurfaceTextureHelper? = null
    private var frames: FlagshipFrameCrypto? = null
    private val pendingIce = ArrayList<String>()
    /** Placing a call: the offer as made, applied (munged as signed) only once the answer brings the ICE server. */
    @Volatile private var caller = false
    private var rawOffer: String? = null
    private val gathered = CompletableDeferred<Unit>()
    @Volatile private var keys: CallFrameCrypto? = null
    @Volatile private var stopped = false
    @Volatile private var connectedOnce = false

    /** The remote camera, for a renderer: our build's EGL context and the caller's video track once it arrives. */
    @Volatile var remoteVideo: VideoTrack? = null
        private set
    val eglContext: EglBase.Context? get() = egl?.eglBaseContext

    override suspend fun answer(offerSdp: String, video: Boolean, turn: CallTurnCredential): String {
        val rate = if (video) TurnResponder.VIDEO_RATE_BYTES_PER_S else TurnResponder.AUDIO_RATE_BYTES_PER_S
        CallTurnGate.factory = { c -> TurnResponder.open(c, rate) }
        val pc = synchronized(lock) { build(video) } ?: throw CallMediaUnavailable()
        pc.awaitSdp { o -> pc.setRemoteDescription(o, SessionDescription(SessionDescription.Type.OFFER, offerSdp)) }
        attachTracks(pc, video)
        val answer = pc.awaitCreate { o -> pc.createAnswer(o, MediaConstraints()) }
        pc.awaitSdp { o -> pc.setLocalDescription(o, answer) }
        synchronized(lock) {
            pendingIce.forEach { pc.addIceCandidate(IceCandidate("0", 0, it)) }
            pendingIce.clear()
        }
        // One loopback host candidate: the signed answer carries it whole, so nothing trickles after it.
        withTimeoutOrNull(GATHER_TIMEOUT_MS) { gathered.await() }
        if (stopped) throw CallMediaUnavailable()
        return pc.localDescription?.description ?: throw CallMediaUnavailable()
    }

    private fun build(video: Boolean, placing: Boolean = false): PeerConnection? {
        if (stopped) return null
        caller = placing
        initialize(context)
        val egl = EglBase.create().also { this.egl = it }
        val adm = JavaAudioDeviceModule.builder(context)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        val options = PeerConnectionFactory.Options().apply {
            // Answering: loopback only (the caller arrives through this phone's TURN responder, never over the LAN or
            // mobile network). Placing a call: the network reaches the callee's TURN server; the policy is relay only.
            if (!placing) networkIgnoreMask = ADAPTER_ETHERNET or ADAPTER_WIFI or ADAPTER_CELLULAR or ADAPTER_VPN or ADAPTER_ANY
        }
        val f = PeerConnectionFactory.builder()
            .setOptions(options)
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        adm.release()
        factory = f
        val config = PeerConnection.RTCConfiguration(emptyList()).apply {
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
        }
        val pc = f.createPeerConnection(config, observer) ?: return null
        this.pc = pc
        audioSource = f.createAudioSource(MediaConstraints())
        audioTrack = f.createAudioTrack("a", audioSource)
        frames = FlagshipFrameCrypto(object : FlagshipFrameCrypto.Delegate {
            override fun seal(video: Boolean, frame: ByteArray): ByteArray? =
                keys?.let { if (video) it.sealVideo(frame) else it.sealAudio(frame) }

            override fun open(video: Boolean, sealed: ByteArray): ByteArray? =
                keys?.let { if (video) it.openVideo(sealed) else it.openAudio(sealed) }
        })
        return pc
    }

    /** The offer made the transceivers: our tracks on them, and the frame layer on every sender and receiver. */
    private fun attachTracks(pc: PeerConnection, video: Boolean) = synchronized(lock) {
        val crypto = frames ?: throw CallMediaUnavailable()
        for (t in pc.transceivers) {
            when (t.mediaType) {
                MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO -> {
                    t.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                    t.sender.setTrack(audioTrack, false)
                }
                MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO -> {
                    if (!video) {
                        t.direction = RtpTransceiver.RtpTransceiverDirection.INACTIVE
                        continue
                    }
                    t.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                    videoTransceiver = t
                    remoteVideo = t.receiver.track() as? VideoTrack
                }
                else -> continue
            }
            crypto.attach(t.sender)
            crypto.attach(t.receiver)
        }
    }

    override fun start(crypto: CallFrameCrypto) {
        keys = crypto
    }

    // ── placing a call ──

    override suspend fun offer(video: Boolean): String {
        val pc = synchronized(lock) { build(video, placing = true) } ?: throw CallMediaUnavailable()
        synchronized(lock) {
            val crypto = frames ?: throw CallMediaUnavailable()
            val audio = pc.addTransceiver(audioTrack, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
                ?: throw CallMediaUnavailable()
            crypto.attach(audio.sender)
            crypto.attach(audio.receiver)
            if (video) {
                // Video is an upgrade of the audio call: the section is offered, the camera starts on the Camera tap.
                val v = pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
                    ?: throw CallMediaUnavailable()
                videoTransceiver = v
                remoteVideo = v.receiver.track() as? VideoTrack
                crypto.attach(v.sender)
                crypto.attach(v.receiver)
            }
        }
        val offer = pc.awaitCreate { o -> pc.createOffer(o, MediaConstraints()) }
        if (stopped) throw CallMediaUnavailable()
        synchronized(lock) { rawOffer = offer.description }
        return offer.description
    }

    override suspend fun applyAnswer(sdp: String, iceServer: CallerIceServer) {
        val pc = synchronized(lock) { pc } ?: throw CallMediaUnavailable()
        val offer = synchronized(lock) { rawOffer } ?: throw CallMediaUnavailable()
        val turn = PeerConnection.IceServer.builder(iceServer.url).setUsername(iceServer.username).setPassword(iceServer.credential).createIceServer()
        val config = PeerConnection.RTCConfiguration(listOf(turn)).apply {
            iceTransportsType = PeerConnection.IceTransportsType.RELAY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
        }
        if (!pc.setConfiguration(config)) throw CallMediaUnavailable()
        // The signed offer is exactly the one applied: the same munging the request's hash was made over.
        pc.awaitSdp { o -> pc.setLocalDescription(o, SessionDescription(SessionDescription.Type.OFFER, com.flagshipserver.app.core.voici.VoiciCalls.mungeSdp(offer))) }
        pc.awaitSdp { o -> pc.setRemoteDescription(o, SessionDescription(SessionDescription.Type.ANSWER, sdp)) }
        synchronized(lock) {
            pendingIce.forEach { pc.addIceCandidate(IceCandidate("0", 0, it)) }
            pendingIce.clear()
        }
    }

    override fun startCaller(crypto: CallFrameCrypto) {
        keys = crypto
    }

    override fun addRemoteIce(candidate: String?) {
        if (candidate == null) return
        synchronized(lock) {
            val pc = pc
            if (pc?.remoteDescription == null) pendingIce.add(candidate) else pc.addIceCandidate(IceCandidate("0", 0, candidate))
        }
    }

    override fun setMuted(muted: Boolean) {
        synchronized(lock) { audioTrack?.setEnabled(!muted) }
    }

    override fun setCamera(on: Boolean): Boolean = synchronized(lock) {
        val t = videoTransceiver ?: return false
        if (!on) {
            stopCamera()
            t.sender.setTrack(null, false)
            return true
        }
        if (videoTrack != null) return true
        if (context.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return false
        val f = factory ?: return false
        val egl = egl ?: return false
        val enumerator = Camera2Enumerator(context)
        val name = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) } ?: enumerator.deviceNames.firstOrNull() ?: return false
        val cap = enumerator.createCapturer(name, null) ?: return false
        val src = f.createVideoSource(false)
        val helper = SurfaceTextureHelper.create("flagship-camera", egl.eglBaseContext)
        cap.initialize(helper, context, src.capturerObserver)
        // voici-calls-v2.md §1.3: 360p at 24 fps by default.
        cap.startCapture(640, 360, 24)
        val track = f.createVideoTrack("v", src)
        t.sender.setTrack(track, false)
        capturer = cap
        textures = helper
        videoSource = src
        videoTrack = track
        true
    }

    private fun stopCamera() {
        runCatching { capturer?.stopCapture() }
        capturer?.dispose()
        capturer = null
        videoTrack?.dispose()
        videoTrack = null
        videoSource?.dispose()
        videoSource = null
        textures?.dispose()
        textures = null
    }

    override fun stop() {
        stopped = true
        keys = null
        CallTurnGate.factory = null
        synchronized(lock) {
            frames?.dispose()
            frames = null
            stopCamera()
            pc?.dispose()
            pc = null
            audioTrack?.dispose()
            audioTrack = null
            audioSource?.dispose()
            audioSource = null
            factory?.dispose()
            factory = null
            egl?.release()
            egl = null
            remoteVideo = null
            videoTransceiver = null
        }
        gathered.complete(Unit)
    }

    private val observer = object : PeerConnection.Observer {
        // Answering, the signed answer carries the one loopback candidate whole; placing a call, relay candidates
        // trickle to the callee through the room.
        override fun onIceCandidate(candidate: IceCandidate) {
            if (caller) onLocalIce?.invoke(candidate.sdp)
        }
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) {
                gathered.complete(Unit)
                onLocalIce?.invoke(null)
            }
        }
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            when (state) {
                PeerConnection.PeerConnectionState.CONNECTED -> if (!connectedOnce) {
                    connectedOnce = true
                    onConnected?.invoke()
                }
                PeerConnection.PeerConnectionState.FAILED -> if (!stopped) onFailed?.invoke()
                else -> {}
            }
        }
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            if (state == PeerConnection.IceConnectionState.CONNECTED || state == PeerConnection.IceConnectionState.COMPLETED) {
                onPathOpen?.also { onPathOpen = null }?.invoke()
            }
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(channel: DataChannel) {}
        override fun onRenegotiationNeeded() {}
    }

    companion object {
        // PeerConnectionFactory.Options adapter bits (rtc::AdapterType).
        private const val ADAPTER_ETHERNET = 1 shl 0
        private const val ADAPTER_WIFI = 1 shl 1
        private const val ADAPTER_CELLULAR = 1 shl 2
        private const val ADAPTER_VPN = 1 shl 3
        private const val ADAPTER_ANY = 1 shl 5
        private const val GATHER_TIMEOUT_MS = 3_000L

        @Volatile private var initialized = false

        @Synchronized private fun initialize(context: Context) {
            if (initialized) return
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
            initialized = true
        }

        private suspend fun PeerConnection.awaitSdp(op: (SdpObserver) -> Unit) = suspendCancellableCoroutine { k ->
            op(object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription) {}
                override fun onSetSuccess() = k.resume(Unit)
                override fun onCreateFailure(error: String?) {}
                override fun onSetFailure(error: String?) = k.resumeWithException(CallMediaUnavailable())
            })
        }

        private suspend fun PeerConnection.awaitCreate(op: (SdpObserver) -> Unit): SessionDescription = suspendCancellableCoroutine { k ->
            op(object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription) = k.resume(sdp)
                override fun onSetSuccess() {}
                override fun onCreateFailure(error: String?) = k.resumeWithException(CallMediaUnavailable())
                override fun onSetFailure(error: String?) {}
            })
        }
    }
}
