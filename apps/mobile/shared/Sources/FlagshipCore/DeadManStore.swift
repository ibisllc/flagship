import Foundation

/// Per-server dead-man heartbeat-lock state the phone remembers locally,
/// keyed by the server's canonical FQDN. Non-secret (no key material — the
/// daemon enforces; this is the phone's view for the UI + reminder
/// scheduling), so plain `UserDefaults` is appropriate.
///
/// Facts:
///   - `enabled` — the opt-in toggle (default OFF).
///   - `windowMs` — affirmation window (default 24h, adjustable to minutes).
///   - `graceMs`  — extra grace past the window before lockout (fixed 6h
///     default; not user-exposed, but part of the signed policy).
///   - `lockoutMode` — "off" (default, rubber-hose posture) or "restart".
///   - `leaseExpiry` — last lease deadline the box reported (from the affirm
///     response). Drives the "time remaining" display + the T-6h/T-1h/T-15m
///     reminder scheduling.
public struct DeadManStore {
    /// Window presets surfaced in the UI. "Tighten now" picks `min15`.
    public enum WindowPreset: String, Sendable, CaseIterable, Hashable {
        case h24, h8, h1, min15

        public var ms: Int64 {
            switch self {
            case .h24:   return 24 * 3600_000
            case .h8:    return 8 * 3600_000
            case .h1:    return 1 * 3600_000
            case .min15: return 15 * 60_000
            }
        }

        public var label: String {
            switch self {
            case .h24:   return "24 hours"
            case .h8:    return "8 hours"
            case .h1:    return "1 hour"
            case .min15: return "15 minutes"
            }
        }

        /// The nearest preset for a stored windowMs (for restoring the picker).
        public static func nearest(ms: Int64) -> WindowPreset {
            allCases.min(by: { abs($0.ms - ms) < abs($1.ms - ms) }) ?? .h24
        }
    }

    public static let defaultWindowMs: Int64 = 24 * 3600_000
    public static let defaultGraceMs: Int64 = 6 * 3600_000
    /// The shortest window "tighten now" drops to.
    public static let tightenWindowMs: Int64 = WindowPreset.min15.ms

    private let defaults: UserDefaults
    private static let enabledPrefix = "flagship.deadman.enabled."
    private static let windowPrefix = "flagship.deadman.windowMs."
    private static let gracePrefix = "flagship.deadman.graceMs."
    private static let lockoutPrefix = "flagship.deadman.lockout."
    private static let expiryPrefix = "flagship.deadman.leaseExpiry."

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ prefix: String, _ serverDomain: String) -> String {
        prefix + serverDomain.lowercased()
    }

    public func isEnabled(for serverDomain: String) -> Bool {
        defaults.bool(forKey: Self.key(Self.enabledPrefix, serverDomain))
    }

    public func windowMs(for serverDomain: String) -> Int64 {
        let v = defaults.object(forKey: Self.key(Self.windowPrefix, serverDomain)) as? NSNumber
        return v?.int64Value ?? Self.defaultWindowMs
    }

    public func graceMs(for serverDomain: String) -> Int64 {
        let v = defaults.object(forKey: Self.key(Self.gracePrefix, serverDomain)) as? NSNumber
        return v?.int64Value ?? Self.defaultGraceMs
    }

    /// "off" (default) or "restart".
    public func lockoutMode(for serverDomain: String) -> String {
        defaults.string(forKey: Self.key(Self.lockoutPrefix, serverDomain)) ?? "off"
    }

    /// Last lease deadline (ms) the box reported, or nil if never affirmed.
    public func leaseExpiry(for serverDomain: String) -> Int64? {
        let v = defaults.object(forKey: Self.key(Self.expiryPrefix, serverDomain)) as? NSNumber
        return v?.int64Value
    }

    public func save(
        serverDomain: String,
        enabled: Bool,
        windowMs: Int64,
        graceMs: Int64,
        lockoutMode: String
    ) {
        defaults.set(enabled, forKey: Self.key(Self.enabledPrefix, serverDomain))
        defaults.set(NSNumber(value: windowMs), forKey: Self.key(Self.windowPrefix, serverDomain))
        defaults.set(NSNumber(value: graceMs), forKey: Self.key(Self.gracePrefix, serverDomain))
        defaults.set(lockoutMode, forKey: Self.key(Self.lockoutPrefix, serverDomain))
    }

    public func setLeaseExpiry(_ expiry: Int64?, for serverDomain: String) {
        let k = Self.key(Self.expiryPrefix, serverDomain)
        if let expiry { defaults.set(NSNumber(value: expiry), forKey: k) } else { defaults.removeObject(forKey: k) }
    }

    public func clear(for serverDomain: String) {
        for p in [Self.enabledPrefix, Self.windowPrefix, Self.gracePrefix, Self.lockoutPrefix, Self.expiryPrefix] {
            defaults.removeObject(forKey: Self.key(p, serverDomain))
        }
    }
}
