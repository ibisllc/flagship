#if os(iOS) && canImport(WebRTC) && canImport(FlagshipTurn)
import AVFoundation
import Flagship
import FlagshipCore
import Foundation
import WebRTC

/// The real media half of a voi.ci call on iOS (docs/voici-calls.md §3, §4; voici-calls-v2.md §1): our libwebrtc build
/// answering the caller's offer. The phone's peer connection gathers one loopback host candidate; the caller reaches
/// it through this phone's own TURN responder (TurnResponder, armed by VoiciCallSession through CallTurnGate). Every
/// encoded frame goes through RTCFlagshipFrameCrypto (the tools/libwebrtc overlay) into CallFrameCrypto: until the
/// keys arrive, and after stop, every frame is dropped. CallKit owns the audio session (CallMediaFactory). Same shape
/// as Android WebRtcCallMediaEngine.kt.
public final class WebRTCCallMediaEngine: NSObject, CallMediaEngine, @unchecked Sendable {
    public var onLocalIce: ((String?) -> Void)?
    public var onConnected: (() -> Void)?
    public var onFailed: (() -> Void)?
    private var onPathOpen: (() -> Void)?
    public func setOnPathOpen(_ f: @escaping () -> Void) { lock.withLock { onPathOpen = f } }

    private static let gatherTimeout: TimeInterval = 3
    private static let configureAudio: Void = {
        let rtc = RTCAudioSession.sharedInstance()
        rtc.useManualAudio = true
        rtc.isAudioEnabled = false
    }()

    private let lock = NSLock()
    private var factory: RTCPeerConnectionFactory?
    private var pc: RTCPeerConnection?
    private var audioTrack: RTCAudioTrack?
    private var videoTransceiver: RTCRtpTransceiver?
    private var videoSource: RTCVideoSource?
    private var videoTrack: RTCVideoTrack?
    private var capturer: RTCCameraVideoCapturer?
    private var frames: RTCFlagshipFrameCrypto?
    private var keys: CallFrameCrypto?
    private var pendingIce: [String] = []
    private var gathered: CheckedContinuation<Void, Never>?
    private var gatheringDone = false
    private var stopped = false
    private var connectedOnce = false
    /// This engine places the call (calling from the app): relay only, through the callee's TURN, candidates trickle.
    private var caller = false
    /// The offer this engine made, applied (munged, exactly as signed) once the answer brings the TURN credential.
    private var offerSdp: String?
    /// No CallKit call owns the audio session (an in-app call): this engine activated it and gives it back on stop.
    private var ownsAudio = false

    /// The caller's camera, for a renderer (RTCMTLVideoView), once the offer made a video transceiver.
    public private(set) var remoteVideo: RTCVideoTrack?

    public override init() {
        _ = Self.configureAudio
        super.init()
    }

    public func answer(offerSdp: String, video: Bool, turn: CallTurnCredential) async throws -> String {
        let rate = video ? TurnResponder.videoRateBytesPerS : TurnResponder.audioRateBytesPerS
        CallTurnGate.shared.factory = { c in TurnResponder.open(c, rateBytesPerS: rate) }
        guard let pc = build() else { throw CallMediaUnavailable() }
        try await pc.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: offerSdp))
        try attachTracks(pc, video: video)
        let answer = try await pc.answer(for: Self.noConstraints)
        try await pc.setLocalDescription(answer)
        let queued: [String] = lock.withLock { defer { pendingIce = [] }; return pendingIce }
        for c in queued { try? await pc.add(RTCIceCandidate(sdp: c, sdpMLineIndex: 0, sdpMid: "0")) }
        // One loopback host candidate: the signed answer carries it whole, so nothing trickles after it.
        await waitForGathering()
        guard !lock.withLock({ stopped }), let sdp = pc.localDescription?.sdp else { throw CallMediaUnavailable() }
        return sdp
    }

    private static let noConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)

    private func build(caller: Bool = false) -> RTCPeerConnection? {
        lock.withLock {
            guard !stopped else { return nil }
            self.caller = caller
            let options = RTCPeerConnectionFactoryOptions()
            if !caller {
                // Loopback only: the caller arrives through this phone's TURN responder, never over Wi-Fi or cellular, so
                // every other adapter is ignored and loopback (ignored by default) is not.
                options.ignoreLoopbackNetworkAdapter = false
                options.ignoreWiFiNetworkAdapter = true
                options.ignoreCellularNetworkAdapter = true
                options.ignoreEthernetNetworkAdapter = true
                options.ignoreVPNNetworkAdapter = true
            }
            let f = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                             decoderFactory: RTCDefaultVideoDecoderFactory())
            f.setOptions(options)
            let config = RTCConfiguration()
            config.iceServers = []
            config.sdpSemantics = .unifiedPlan
            config.bundlePolicy = .maxBundle
            config.rtcpMuxPolicy = .require
            config.tcpCandidatePolicy = .disabled
            config.continualGatheringPolicy = .gatherOnce
            // Placing a call: the callee's phone is the only ICE server (set with its one-time credential once the
            // answer arrives), relay candidates only, as a voi.ci browser does (docs/voici-calls.md §0.1).
            if caller { config.iceTransportPolicy = .relay }
            guard let pc = f.peerConnection(with: config, constraints: Self.noConstraints, delegate: self) else { return nil }
            factory = f
            self.pc = pc
            audioTrack = f.audioTrack(with: f.audioSource(with: Self.noConstraints), trackId: "a")
            frames = RTCFlagshipFrameCrypto(delegate: self)
            return pc
        }
    }

    /// The offer made the transceivers: our tracks on them, and the frame layer on every sender and receiver.
    private func attachTracks(_ pc: RTCPeerConnection, video: Bool) throws {
        try lock.withLock {
            guard let frames else { throw CallMediaUnavailable() }
            for t in pc.transceivers {
                switch t.mediaType {
                case .audio:
                    var err: NSError?
                    t.setDirection(.sendRecv, error: &err)
                    t.sender.track = audioTrack
                case .video:
                    var err: NSError?
                    guard video else { t.setDirection(.inactive, error: &err); continue }
                    t.setDirection(.sendRecv, error: &err)
                    videoTransceiver = t
                    remoteVideo = t.receiver.track as? RTCVideoTrack
                default:
                    continue
                }
                frames.attach(sender: t.sender)
                frames.attach(receiver: t.receiver)
            }
        }
    }

    private func waitForGathering() async {
        await withTaskGroup(of: Void.self) { g in
            g.addTask { [weak self] in
                await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
                    guard let self else { return k.resume() }
                    let done: Bool = self.lock.withLock {
                        if self.gatheringDone || self.stopped { return true }
                        self.gathered = k
                        return false
                    }
                    if done { k.resume() }
                }
            }
            g.addTask { try? await Task.sleep(nanoseconds: UInt64(Self.gatherTimeout * 1_000_000_000)) }
            await g.next()
            self.finishGathering()
            g.cancelAll()
        }
    }

    private func finishGathering() {
        let k: CheckedContinuation<Void, Never>? = lock.withLock {
            gatheringDone = true
            defer { gathered = nil }
            return gathered
        }
        k?.resume()
    }

    public func start(_ crypto: CallFrameCrypto) { lock.withLock { keys = crypto } }

    // MARK: placing a call (calling from the app)

    /// The caller's offer: audio (and a video section when the call may carry video), the frame layer on every sender
    /// and receiver. Nothing is gathered yet: the local description is applied with the callee's TURN server.
    public func offer(video: Bool) async throws -> String {
        guard let pc = build(caller: true) else { throw CallMediaUnavailable() }
        try lock.withLock {
            guard let frames, let audioTrack else { throw CallMediaUnavailable() }
            let ai = RTCRtpTransceiverInit()
            ai.direction = .sendRecv
            guard let at = pc.addTransceiver(with: audioTrack, init: ai) else { throw CallMediaUnavailable() }
            frames.attach(sender: at.sender)
            frames.attach(receiver: at.receiver)
            if video {
                let vi = RTCRtpTransceiverInit()
                vi.direction = .sendRecv
                guard let vt = pc.addTransceiver(of: .video, init: vi) else { throw CallMediaUnavailable() }
                videoTransceiver = vt
                remoteVideo = vt.receiver.track as? RTCVideoTrack
                frames.attach(sender: vt.sender)
                frames.attach(receiver: vt.receiver)
            }
        }
        let offer = try await pc.offer(for: Self.noConstraints)
        lock.withLock { offerSdp = offer.sdp }
        return offer.sdp
    }

    /// The callee's checked answer: the TURN server goes in first, then the signed offer (munged, byte for byte what
    /// the request hashed) and the answer, whose DTLS fingerprint WebRTC then holds the connection to.
    public func applyAnswer(sdp: String, iceServer: CallerIceServer) async throws {
        guard let pc = lock.withLock({ self.pc }), let raw = lock.withLock({ offerSdp }) else { throw CallMediaUnavailable() }
        let config = pc.configuration
        config.iceServers = [RTCIceServer(urlStrings: [iceServer.url], username: iceServer.username, credential: iceServer.credential)]
        config.iceTransportPolicy = .relay
        guard pc.setConfiguration(config) else { throw CallMediaUnavailable() }
        activateAudioIfNeeded()
        try await pc.setLocalDescription(RTCSessionDescription(type: .offer, sdp: VoiciCalls.mungeSdp(raw)))
        try await pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp))
        let queued: [String] = lock.withLock { defer { pendingIce = [] }; return pendingIce }
        for c in queued { try? await pc.add(RTCIceCandidate(sdp: c, sdpMLineIndex: 0, sdpMid: "0")) }
    }

    /// Keys for the caller's direction (`CallFrameCrypto.caller`: sends c2p, opens p2c).
    public func startCaller(_ crypto: CallFrameCrypto) { lock.withLock { keys = crypto } }

    /// An in-app call has no CallKit call to hand WebRTC the audio session: take it here (voice chat, the speaker
    /// route the system picks), and give it back on stop. A call CallKit answered (a ring-back) already has it.
    private func activateAudioIfNeeded() {
        let rtc = RTCAudioSession.sharedInstance()
        guard !rtc.isAudioEnabled else { return }
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP])
            try s.setActive(true)
        } catch {
            return
        }
        CallMediaFactory.audioSessionDidActivate(s)
        lock.withLock { ownsAudio = true }
    }

    public func addRemoteIce(_ candidate: String?) {
        guard let candidate else { return }
        let pc: RTCPeerConnection? = lock.withLock {
            guard let pc = self.pc, pc.remoteDescription != nil else { pendingIce.append(candidate); return nil }
            return pc
        }
        pc?.add(RTCIceCandidate(sdp: candidate, sdpMLineIndex: 0, sdpMid: "0")) { _ in }
    }

    public func setMuted(_ muted: Bool) { lock.withLock { audioTrack?.isEnabled = !muted } }

    public func setCamera(_ on: Bool) -> Bool {
        lock.withLock {
            guard let t = videoTransceiver, let f = factory else { return false }
            guard on else {
                stopCamera()
                t.sender.track = nil
                return true
            }
            if videoTrack != nil { return true }
            guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized,
                  let device = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == .front })
                    ?? RTCCameraVideoCapturer.captureDevices().first,
                  let format = Self.format(for: device) else { return false }
            let src = f.videoSource()
            let cap = RTCCameraVideoCapturer(delegate: src)
            // voici-calls-v2.md §1.3: 360p at 24 fps by default.
            let maxRate: Float64 = format.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 24
            let fps = Int(min(24, maxRate))
            cap.startCapture(with: device, format: format, fps: fps)
            let track = f.videoTrack(with: src, trackId: "v")
            t.sender.track = track
            capturer = cap
            videoSource = src
            videoTrack = track
            return true
        }
    }

    /// The smallest format at least 640x360.
    private static func format(for device: AVCaptureDevice) -> AVCaptureDevice.Format? {
        var best: AVCaptureDevice.Format?
        var bestArea = Int.max
        for f in RTCCameraVideoCapturer.supportedFormats(for: device) {
            let d: CMVideoDimensions = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let w = Int(d.width)
            let h = Int(d.height)
            guard w >= 640, h >= 360, w * h < bestArea else { continue }
            best = f
            bestArea = w * h
        }
        return best
    }

    private func stopCamera() {
        capturer?.stopCapture()
        capturer = nil
        videoTrack = nil
        videoSource = nil
    }

    public func stop() {
        CallTurnGate.shared.factory = nil
        let pc: RTCPeerConnection? = lock.withLock {
            stopped = true
            keys = nil
            frames?.detach()
            frames = nil
            stopCamera()
            let p = self.pc
            self.pc = nil
            audioTrack = nil
            videoTransceiver = nil
            remoteVideo = nil
            factory = nil
            return p
        }
        pc?.close()
        finishGathering()
        if lock.withLock({ defer { ownsAudio = false }; return ownsAudio }) {
            let session = AVAudioSession.sharedInstance()
            CallMediaFactory.audioSessionDidDeactivate(session)
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}

extension WebRTCCallMediaEngine: RTCFlagshipFrameCryptoDelegate {
    public func sealFrame(_ frame: Data, video: Bool) -> Data? {
        guard let k = lock.withLock({ keys }) else { return nil }
        let out = video ? k.sealVideo([UInt8](frame)) : k.sealAudio([UInt8](frame))
        return out.map { Data($0) }
    }

    public func openFrame(_ frame: Data, video: Bool) -> Data? {
        guard let k = lock.withLock({ keys }) else { return nil }
        let out = video ? k.openVideo([UInt8](frame)) : k.openAudio([UInt8](frame))
        return out.map { Data($0) }
    }
}

extension WebRTCCallMediaEngine: RTCPeerConnectionDelegate {
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        guard newState == .complete else { return }
        finishGathering()
        onLocalIce?(nil)
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        switch newState {
        case .connected:
            let first: Bool = lock.withLock { defer { connectedOnce = true }; return !connectedOnce }
            if first { onConnected?() }
        case .failed:
            if !lock.withLock({ stopped }) { onFailed?() }
        default:
            break
        }
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    public func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        guard newState == .connected || newState == .completed else { return }
        let f: (() -> Void)? = lock.withLock { defer { onPathOpen = nil }; return onPathOpen }
        f?()
    }
    public func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        // The callee bakes its one loopback candidate into the signed answer; the caller trickles its relay candidates.
        guard lock.withLock({ caller }) else { return }
        onLocalIce?(candidate.sdp)
    }
    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
#endif
