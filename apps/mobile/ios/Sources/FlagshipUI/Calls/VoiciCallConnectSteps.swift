import Foundation

/// The steps of connecting an answered call on this phone, in the order they happen (the call screen's status line;
/// the caller's browser shows its own, flagship-web VOICI_CALL_STEPS): holding this phone's bare name, the signed
/// quantum-safe answer until `.com` says this device won, the caller's TURN stream and ICE through it, then DTLS until
/// the first media.
public enum VoiciCallConnectStep: String, CaseIterable, Sendable {
    case route, secure, path, audio
}

/// Forward only: a late event never shows an earlier step. One step past `slowSeconds` shows "This is taking longer
/// than usual"; connecting past `limitSeconds` in all ends the call as "The call couldn't connect."
public struct VoiciCallConnectSteps: Equatable, Sendable {
    public static let slowSeconds: Double = 20
    public static let limitSeconds: Double = 45

    public private(set) var current: VoiciCallConnectStep?

    public init() {}

    /// True when `step` is new and later than the current one.
    public mutating func advance(to step: VoiciCallConnectStep) -> Bool {
        let all = VoiciCallConnectStep.allCases
        if let c = current, let a = all.firstIndex(of: c), let b = all.firstIndex(of: step), b <= a { return false }
        current = step
        return true
    }
}
