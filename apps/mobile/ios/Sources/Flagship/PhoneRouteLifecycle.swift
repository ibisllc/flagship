import Foundation

/// When the phone's tunnel (its bare name, docs/architecture-v2/phone-route.md §4) is open: while the app is in the
/// foreground, and while a voi.ci call rings or runs on this device. A call's media reaches the phone only through its
/// bare name (`turns:<account>.<apex>:443`, docs/voici-calls.md §4), and CallKit answers with the app in the background,
/// so a foreground-only tunnel left every call answered from the lock screen or a banner without a path for its media.
public struct PhoneRouteLifecycle: Equatable, Sendable {
    public private(set) var foreground = false
    public private(set) var calls = 0

    public init() {}

    public var wantsTunnel: Bool { foreground || calls > 0 }

    /// Each returns whether the tunnel should now be open.
    public mutating func enterForeground() -> Bool { foreground = true; return wantsTunnel }
    public mutating func enterBackground() -> Bool { foreground = false; return wantsTunnel }
    public mutating func callStarted() -> Bool { calls += 1; return wantsTunnel }
    public mutating func callEnded() -> Bool { calls = max(0, calls - 1); return wantsTunnel }
}
