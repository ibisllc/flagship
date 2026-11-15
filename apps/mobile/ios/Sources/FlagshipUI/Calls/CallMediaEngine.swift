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

    init(callId: String, audio: (c2p: [UInt8], p2c: [UInt8]), video: (c2p: [UInt8], p2c: [UInt8])?) {
        audioOut = VoiciCallFrameSender(baseKey: audio.p2c, callId: callId, dir: .p2c)
        audioIn = VoiciCallFrameReceiver(baseKey: audio.c2p, callId: callId, dir: .c2p)
        videoOut = video.map { VoiciCallFrameSender(baseKey: $0.p2c, callId: callId, dir: .p2c, video: true) }
        videoIn = video.map { VoiciCallFrameReceiver(baseKey: $0.c2p, callId: callId, dir: .c2p, video: true) }
    }

    public var hasVideo: Bool { videoOut != nil }
    public func sealAudio(_ f: [UInt8]) -> [UInt8]? { lock.withLock { try? audioOut.seal(f) } }
    public func openAudio(_ s: [UInt8]) -> [UInt8]? { lock.withLock { audioIn.open(s) } }
    public func sealVideo(_ f: [UInt8]) -> [UInt8]? { lock.withLock { try? videoOut?.seal(f) } }
    public func openVideo(_ s: [UInt8]) -> [UInt8]? { lock.withLock { videoIn?.open(s) } }
}

public struct CallMediaUnavailable: Error {}

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
