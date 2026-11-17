#if os(iOS) && canImport(WebRTC) && canImport(FlagshipTurn)
import AVFoundation
import Flagship
import FlagshipCore
import Foundation
import OSLog
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
    let frameStats = CallFrameStats()
    private var statsTimer: DispatchSourceTimer?
    private var routeObserver: NSObjectProtocol?

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
        Self.capAudio(pc)
        let queued: [String] = lock.withLock { defer { pendingIce = [] }; return pendingIce }
        for c in queued { try? await pc.add(RTCIceCandidate(sdp: c, sdpMLineIndex: 0, sdpMid: "0")) }
        // One loopback host candidate: the signed answer carries it whole, so nothing trickles after it.
        await waitForGathering()
        guard !lock.withLock({ stopped }), let sdp = pc.localDescription?.sdp else { throw CallMediaUnavailable() }
        let lines = sdp.components(separatedBy: "\n").filter { $0.hasPrefix("a=candidate:") }
        voiciCallLog.notice("answer sdp: \(lines.count, privacy: .public) candidates [\(lines.map(Self.describeCandidate).joined(separator: "; "), privacy: .public)]")
        // ICE ufrags (not the passwords): the checks' USERNAME in the turn mix lines must be "<ours>:<theirs>" one way
        // and "<theirs>:<ours>" the other, or every check is refused.
        let ufrag = { (s: String) in s.components(separatedBy: "\n").filter { $0.hasPrefix("a=ice-ufrag:") }.map { $0.dropFirst(12).trimmingCharacters(in: .whitespacesAndNewlines) } }
        voiciCallLog.notice("ice ufrags: ours \(ufrag(sdp).joined(separator: ","), privacy: .public), theirs \(ufrag(offerSdp).joined(separator: ","), privacy: .public)")
        return sdp
    }

    private static let noConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)

    /// For the calls log: a candidate's type, protocol and address kind, never a non-loopback address. A loopback
    /// candidate keeps its port (it is this phone's own, and tells the relay socket's side apart).
    static func describeCandidate(_ sdp: String) -> String {
        let f = sdp.replacingOccurrences(of: "a=", with: "").split(separator: " ").map(String.init)
        guard f.count >= 8 else { return "unparsed" }
        let proto = f[2].lowercased(), addr = f[4], port = f[5]
        let typ = f.firstIndex(of: "typ").flatMap { $0 + 1 < f.count ? f[$0 + 1] : nil } ?? "?"
        let kind: String
        if addr == "127.0.0.1" || addr == "::1" { kind = "loopback:\(port)" }
        else if addr.hasSuffix(".local") { kind = "mdns" }
        else if addr.contains(":") { kind = "ipv6" }
        else { kind = "ipv4" }
        return "\(typ)/\(proto)/\(kind)"
    }

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
    /// Audio frames are sealed into a fixed 63-byte slot (voici-calls.md §3): 24 kbit/s CBR in 20 ms frames is 60
    /// bytes. The signed SDP asks for it; the sender's own cap keeps a larger frame from ever being encoded and dropped.
    private static func capAudio(_ pc: RTCPeerConnection) {
        for t in pc.transceivers where t.mediaType == .audio {
            let p = t.sender.parameters
            guard !p.encodings.isEmpty else { continue }
            for e in p.encodings { e.maxBitrateBps = NSNumber(value: 24_000) }
            t.sender.parameters = p
        }
    }

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
        Self.capAudio(pc)
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
        guard let candidate else {
            voiciCallLog.notice("remote ice: end of candidates")
            return
        }
        voiciCallLog.notice("remote ice: \(Self.describeCandidate(candidate), privacy: .public)")
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

    /// Every 2 s while connected: the audio session's format and route, and WebRTC's audio send/receive stats (sizes,
    /// counts and levels only), so a garbled call shows whether the capture side or the receive side is at fault.
    private func startAudioStatsLog(_ pc: RTCPeerConnection) {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "flagship.call-stats"))
        let installed: Bool = lock.withLock {
            guard statsTimer == nil, !stopped else { return false }
            statsTimer = t
            return true
        }
        guard installed else { return }
        Self.logAudioSession("at connect")
        t.schedule(deadline: .now() + 2, repeating: 2)
        t.setEventHandler { [weak pc] in
            pc?.statistics { report in
                var parts: [String] = []
                for (_, st) in report.statistics {
                    let v = st.values
                    let kind = v["kind"] as? String ?? v["mediaType"] as? String
                    func n(_ k: String) -> String { (v[k] as? NSNumber).map { "\($0)" } ?? "?" }
                    switch (st.type, kind) {
                    case ("media-source", "audio"):
                        parts.append("mic level \(n("audioLevel")) energy \(n("totalAudioEnergy")) dur \(n("totalSamplesDuration"))")
                    case ("outbound-rtp", "audio"):
                        var codec = "?"
                        if let cid = v["codecId"] as? String, let c = report.statistics[cid]?.values {
                            codec = "\(c["mimeType"] as? String ?? "?") \((c["clockRate"] as? NSNumber).map { "\($0)" } ?? "?") \((c["channels"] as? NSNumber).map { "\($0)" } ?? "?")ch \(c["sdpFmtpLine"] as? String ?? "")"
                        }
                        parts.append("out packets \(n("packetsSent")) bytes \(n("bytesSent")) target \(n("targetBitrate")) codec \(codec)")
                    case ("inbound-rtp", "audio"):
                        parts.append("in packets \(n("packetsReceived")) lost \(n("packetsLost")) concealed \(n("concealedSamples"))/\(n("totalSamplesReceived")) level \(n("audioLevel"))")
                    default:
                        break
                    }
                }
                if !parts.isEmpty { voiciCallLog.notice("audio stats: \(parts.sorted().joined(separator: "; "), privacy: .public)") }
            }
        }
        t.resume()
        let obs = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { note in
            let why = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.intValue ?? -1
            Self.logAudioSession("route change \(why)")
        }
        lock.withLock { routeObserver = obs }
    }

    static func logAudioSession(_ when: String) {
        let s = AVAudioSession.sharedInstance()
        let ins = s.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ",")
        let outs = s.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ",")
        voiciCallLog.notice("audio session \(when, privacy: .public): \(s.category.rawValue, privacy: .public)/\(s.mode.rawValue, privacy: .public) rate \(s.sampleRate, privacy: .public) (preferred \(s.preferredSampleRate, privacy: .public)) io \(s.ioBufferDuration, privacy: .public) in \(s.inputNumberOfChannels, privacy: .public)ch [\(ins, privacy: .public)] out \(s.outputNumberOfChannels, privacy: .public)ch [\(outs, privacy: .public)]")
    }

    public func stop() {
        let (st, obs): (DispatchSourceTimer?, NSObjectProtocol?) = lock.withLock {
            defer { statsTimer = nil; routeObserver = nil }
            return (statsTimer, routeObserver)
        }
        st?.cancel()
        if let obs { NotificationCenter.default.removeObserver(obs) }
        CallTurnGate.shared.factory = nil
        frameStats.end()
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
        guard let k = lock.withLock({ keys }) else {
            frameStats.count(video ? "v-seal-nokey" : "a-seal-nokey", size: frame.count)
            return nil
        }
        let out = video ? k.sealVideo([UInt8](frame)) : k.sealAudio([UInt8](frame))
        frameStats.count((video ? "v-seal-" : "a-seal-") + (out == nil ? "refused" : "ok"), size: frame.count)
        return out.map { Data($0) }
    }

    public func openFrame(_ frame: Data, video: Bool) -> Data? {
        guard let k = lock.withLock({ keys }) else {
            frameStats.count(video ? "v-open-nokey" : "a-open-nokey", size: frame.count)
            return nil
        }
        let out = video ? k.openVideo([UInt8](frame)) : k.openAudio([UInt8](frame))
        frameStats.count((video ? "v-open-" : "a-open-") + (out == nil ? "failed" : "ok"), size: frame.count)
        return out.map { Data($0) }
    }
}

/// Frame-layer counts for the device log (no content): every 2 s while frames flow, and once at the end, so a silent
/// call shows whether the phone seals and opens audio at all (`a-seal-refused` with its largest size = frames over the
/// 63-byte audio limit; `a-open-failed` = wrong keys or direction).
final class CallFrameStats: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: (n: Int, max: Int)] = [:]
    private var totals: [String: (n: Int, max: Int)] = [:]
    private var timer: DispatchSourceTimer?

    /// The whole call's count for one key (tests).
    func total(_ key: String) -> (n: Int, max: Int) { lock.withLock { totals[key] ?? (0, 0) } }

    func count(_ key: String, size: Int) {
        let start: Bool = lock.withLock {
            let c = counts[key] ?? (0, 0)
            counts[key] = (c.n + 1, max(c.max, size))
            let t = totals[key] ?? (0, 0)
            totals[key] = (t.n + 1, max(t.max, size))
            return timer == nil
        }
        if start { startTimer() }
    }

    private func startTimer() {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "flagship.call-frames"))
        let installed: Bool = lock.withLock {
            guard timer == nil else { return false }
            timer = t
            return true
        }
        guard installed else { return }
        t.schedule(deadline: .now() + 2, repeating: 2)
        t.setEventHandler { [weak self] in self?.flush("frames") }
        t.resume()
    }

    func flush(_ label: String) {
        let snap: [String: (n: Int, max: Int)] = lock.withLock { defer { counts = [:] }; return counts }
        guard !snap.isEmpty else { return }
        let line = snap.keys.sorted().map { "\($0)=\(snap[$0]!.n) (max \(snap[$0]!.max) B)" }.joined(separator: ", ")
        voiciCallLog.notice("\(label, privacy: .public): \(line, privacy: .public)")
    }

    func end() {
        let t: DispatchSourceTimer? = lock.withLock { defer { timer = nil }; return timer }
        t?.cancel()
        flush("frames at end")
    }
}

extension WebRTCCallMediaEngine: RTCPeerConnectionDelegate {
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        voiciCallLog.notice("ice gathering: \(newState.rawValue, privacy: .public) (0 new, 1 gathering, 2 complete)")
        guard newState == .complete else { return }
        finishGathering()
        onLocalIce?(nil)
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        voiciCallLog.notice("peer connection: \(newState.rawValue, privacy: .public) (0 new, 1 connecting, 2 connected, 3 disconnected, 4 failed, 5 closed)")
        switch newState {
        case .connected:
            let first: Bool = lock.withLock { defer { connectedOnce = true }; return !connectedOnce }
            if first {
                startAudioStatsLog(peerConnection)
                onConnected?()
            }
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
        voiciCallLog.notice("ice connection: \(newState.rawValue, privacy: .public) (0 new, 1 checking, 2 connected, 3 completed, 4 failed, 5 disconnected, 6 closed)")
        guard newState == .connected || newState == .completed else { return }
        let f: (() -> Void)? = lock.withLock { defer { onPathOpen = nil }; return onPathOpen }
        f?()
    }
    public func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        // The callee bakes its one loopback candidate into the signed answer; the caller trickles its relay candidates.
        voiciCallLog.notice("local ice: \(Self.describeCandidate(candidate.sdp), privacy: .public)")
        guard lock.withLock({ caller }) else { return }
        onLocalIce?(candidate.sdp)
    }
    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
#endif
