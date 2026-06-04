import Foundation
import Observation

/// Account-wide TLS-certificate validity window.
///
/// This is the dead-man's-switch: the number of days a managed server keeps
/// serving before its certificate lapses if no admin device surfaces to renew.
/// It's set ONCE per account (in Settings) rather than per-server — we assume a
/// user grants minting authority only to equally-trusted devices/servers, so a
/// single window keeps the choice simple. The value is stamped into each
/// managed server's signed install blob as `offlineWindowDays` at creation; the
/// protocol still carries it per-blob, so each grant *could* differ — we just
/// don't surface that.
///
/// Persisted in UserDefaults so the choice survives launches. Default 30 days.
/// Not actor-isolated so it can be a default argument on the create-server
/// view-model's init; it's a thin UserDefaults wrapper, read/written on main.
@Observable
public final class CertValidityStore {
    private let defaults: UserDefaults
    private let daysKey = "flagship.cert.validityDays"

    /// The presets offered in Settings, in days.
    public static let presets: [Int] = [7, 30, 90]
    public static let defaultDays = 30

    /// The account-wide validity window in days. Writes that aren't one of the
    /// presets are clamped to the default so a stray value can't widen the
    /// window unexpectedly.
    public var days: Int {
        didSet {
            if !Self.presets.contains(days) { days = Self.defaultDays }
            defaults.set(days, forKey: daysKey)
        }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let raw = defaults.integer(forKey: daysKey)  // 0 when absent
        self.days = Self.presets.contains(raw) ? raw : Self.defaultDays
    }
}
