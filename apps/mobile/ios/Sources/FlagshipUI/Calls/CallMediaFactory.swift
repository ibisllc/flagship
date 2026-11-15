#if os(iOS)
import AVFoundation
import Foundation
#if canImport(WebRTC) && canImport(FlagshipTurn)
import WebRTC
#endif

/// Picks the call media engine: our libwebrtc build (WebRTCCallMediaEngine) when the app was built with the CI's
/// libraries in Vendor/WebRTC (tools/libwebrtc, Package.swift), else StubCallMediaEngine (calls ring, never connect).
public enum CallMediaFactory {
    #if canImport(WebRTC) && canImport(FlagshipTurn)
    public static let bundled = true

    public static func make() -> CallMediaEngine { WebRTCCallMediaEngine() }

    public static func audioSessionDidActivate(_ s: AVAudioSession) {
        let rtc = RTCAudioSession.sharedInstance()
        rtc.audioSessionDidActivate(s)
        rtc.isAudioEnabled = true
    }

    public static func audioSessionDidDeactivate(_ s: AVAudioSession) {
        let rtc = RTCAudioSession.sharedInstance()
        rtc.isAudioEnabled = false
        rtc.audioSessionDidDeactivate(s)
    }

    /// The linked TURN responder answers a STUN Binding request with a Binding success (the media CI lane's check).
    public static func turnSelfTest() -> Bool {
        guard let t = TurnResponder.open(.init(user: "u", secret: "s"), rateBytesPerS: TurnResponder.audioRateBytesPerS) else {
            return false
        }
        defer { t.close() }
        let binding = Data([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42] + [UInt8](repeating: 7, count: 12))
        guard let out = t.onClientBytes(binding), let first = out.first, first.count >= 20 else { return false }
        return first[first.startIndex] == 0x01 && first[first.startIndex + 1] == 0x01
            && t.onClientBytes(Data("PUT / HTTP/1.1\r\n".utf8)) == nil
    }
    #else
    public static let bundled = false

    public static func make() -> CallMediaEngine { StubCallMediaEngine() }
    public static func audioSessionDidActivate(_ s: AVAudioSession) {}
    public static func audioSessionDidDeactivate(_ s: AVAudioSession) {}
    public static func turnSelfTest() -> Bool { false }
    #endif
}
#endif
