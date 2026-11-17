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

    /// Voice chat for the call before CallKit activates the session: CallKit activates whatever category is set, and
    /// WebRTC's voice-processing unit captures and plays nothing in the default (playback-only) category.
    public static func prepareAudioSession() {
        let rtc = RTCAudioSession.sharedInstance()
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        let cfg = RTCAudioSessionConfiguration.webRTC()
        cfg.category = AVAudioSession.Category.playAndRecord.rawValue
        cfg.mode = AVAudioSession.Mode.voiceChat.rawValue
        cfg.categoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
        do {
            try rtc.setConfiguration(cfg)
        } catch {
            voiciCallLog.notice("audio session: configure failed \((error as NSError).code, privacy: .public)")
        }
    }

    public static func audioSessionDidActivate(_ s: AVAudioSession) {
        let rtc = RTCAudioSession.sharedInstance()
        if s.category != .playAndRecord { prepareAudioSession() }
        rtc.audioSessionDidActivate(s)
        rtc.isAudioEnabled = true
        voiciCallLog.notice("audio session: active \(s.category.rawValue, privacy: .public)/\(s.mode.rawValue, privacy: .public), webrtc enabled \(rtc.isAudioEnabled, privacy: .public), manual \(rtc.useManualAudio, privacy: .public)")
        WebRTCCallMediaEngine.logAudioSession("at activation")
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
    public static func prepareAudioSession() {}
    public static func audioSessionDidActivate(_ s: AVAudioSession) {}
    public static func audioSessionDidDeactivate(_ s: AVAudioSession) {}
    public static func turnSelfTest() -> Bool { false }
    #endif
}
#endif
