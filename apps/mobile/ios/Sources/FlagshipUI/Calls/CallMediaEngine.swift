import Foundation
import FlagshipCore

/// The answering phone's one-time TURN credential (the answer carries it to the caller).
public struct CallTurnCredential: Sendable {
    public let user: String
    public let secret: String
}

/// The frame layer of one call on the answering phone (docs/voici-calls.md §3, voici-calls-v2.md §1.5): it sends
/// p2c and receives c2p, audio and video on their own keys and counters. A WebRTC FrameEncryptor / FrameDecryptor
/// calls these for every encoded frame; a frame that fails to open is dropped, never decoded.
public final class CallFrameCrypto: @unchecked Sendable {
    private let lock = NSLock()
    private let audioOut: VoiciCallFrameSender
    private let audioIn: VoiciCallFrameReceiver
    private let videoOut: VoiciCallFrameSender?
    private let videoIn: VoiciCallFrameReceiver?

    convenience init(callId: String, audio: (c2p: [UInt8], p2c: [UInt8]), video: (c2p: [UInt8], p2c: [UInt8])?) {
        self.init(callId: callId, audio: audio, video: video, out: .p2c)
    }

    /// The caller's side (this app placed the call): it sends c2p and receives p2c.
    static func caller(callId: String, audio: (c2p: [UInt8], p2c: [UInt8]), video: (c2p: [UInt8], p2c: [UInt8])?) -> CallFrameCrypto {
        CallFrameCrypto(callId: callId, audio: audio, video: video, out: .c2p)
    }

    private init(callId: String, audio: (c2p: [UInt8], p2c: [UInt8]), video: (c2p: [UInt8], p2c: [UInt8])?, out: VoiciCallDir) {
        let inDir: VoiciCallDir = out == .p2c ? .c2p : .p2c
        let key = { (k: (c2p: [UInt8], p2c: [UInt8]), d: VoiciCallDir) in d == .c2p ? k.c2p : k.p2c }
        audioOut = VoiciCallFrameSender(baseKey: key(audio, out), callId: callId, dir: out)
        audioIn = VoiciCallFrameReceiver(baseKey: key(audio, inDir), callId: callId, dir: inDir)
        videoOut = video.map { VoiciCallFrameSender(baseKey: key($0, out), callId: callId, dir: out, video: true) }
        videoIn = video.map { VoiciCallFrameReceiver(baseKey: key($0, inDir), callId: callId, dir: inDir, video: true) }
        sendsDir = out
    }

    /// The direction this side seals (p2c on the answering phone, c2p when this app placed the call).
    public let sendsDir: VoiciCallDir

    public var hasVideo: Bool { videoOut != nil }
    public func sealAudio(_ f: [UInt8]) -> [UInt8]? { lock.withLock { try? audioOut.seal(f) } }
    public func openAudio(_ s: [UInt8]) -> [UInt8]? { lock.withLock { audioIn.open(s) } }
    public func sealVideo(_ f: [UInt8]) -> [UInt8]? { lock.withLock { try? videoOut?.seal(f) } }
    public func openVideo(_ s: [UInt8]) -> [UInt8]? { lock.withLock { videoIn?.open(s) } }
}

public struct CallMediaUnavailable: Error {}

/// The callee's phone as the caller's only ICE server: `turns:<callee>.<servicesApex>:443?transport=tcp`, relay only,
/// with the one-time credential from the signed answer (docs/voici-calls.md §0.1).
public struct CallerIceServer: Equatable, Sendable {
    public let url: String
    public let username: String
    public let credential: String
}

/// The media half of a voi.ci call: WebRTC answering the caller's offer over the phone's own TURN responder, frames
/// sealed by `CallFrameCrypto`. The signalling (VoiciCallSession) and CallKit depend only on this protocol, so the
/// WebRTC library is one implementation behind it. None is bundled yet (the libwebrtc build is an open owner decision,
/// docs/voici-calls.md "Open items"): `StubCallMediaEngine` refuses to answer and the call ends with its sentence.
public protocol CallMediaEngine: AnyObject {
    /// Applies the caller's (checked) offer and returns this phone's answer SDP, before munging.
    func answer(offerSdp: String, video: Bool, turn: CallTurnCredential) async throws -> String
    /// This device won: media may flow under these keys.
    func start(_ crypto: CallFrameCrypto)
    func addRemoteIce(_ candidate: String?)
    var onLocalIce: ((String?) -> Void)? { get set }
    var onConnected: (() -> Void)? { get set }
    var onFailed: (() -> Void)? { get set }
    func setMuted(_ muted: Bool)
    /// Turns this phone's camera on or off; false when it can't.
    func setCamera(_ on: Bool) -> Bool
    func stop()

    // Calling from the app (docs/voici-calls.md "Calling from the app"): this app places the call. An engine without
    // these (the defaults below) can't place calls, and the app hands the call to the browser instead.

    /// The caller's offer (before munging), made before the request; nothing is gathered until `applyAnswer`, which
    /// sets the callee's TURN server as the only ICE server (relay only).
    func offer(video: Bool) async throws -> String
    /// The callee's checked answer SDP and its one-time TURN server.
    func applyAnswer(sdp: String, iceServer: CallerIceServer) async throws
    /// The answer checked out: media may flow under these keys (`CallFrameCrypto.caller`).
    func startCaller(_ crypto: CallFrameCrypto)
    /// Called once ICE connects through the caller's TURN stream (the call screen's "Starting audio…" step).
    func setOnPathOpen(_ f: @escaping () -> Void)
}

public extension CallMediaEngine {
    func setOnPathOpen(_ f: @escaping () -> Void) {}
    func offer(video: Bool) async throws -> String { throw CallMediaUnavailable() }
    func applyAnswer(sdp: String, iceServer: CallerIceServer) async throws { throw CallMediaUnavailable() }
    func startCaller(_ crypto: CallFrameCrypto) {}
}

/// No WebRTC library in this build: every answer is refused, so a call rings but never connects.
public final class StubCallMediaEngine: CallMediaEngine {
    public init() {}
    public func answer(offerSdp: String, video: Bool, turn: CallTurnCredential) async throws -> String { throw CallMediaUnavailable() }
    public func start(_ crypto: CallFrameCrypto) {}
    public func addRemoteIce(_ candidate: String?) {}
    public var onLocalIce: ((String?) -> Void)?
    public var onConnected: (() -> Void)?
    public var onFailed: (() -> Void)?
    public func setMuted(_ muted: Bool) {}
    public func setCamera(_ on: Bool) -> Bool { false }
    public func stop() {}
}
