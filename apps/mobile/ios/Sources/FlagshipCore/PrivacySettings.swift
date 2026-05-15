import Foundation
import Observation

/// B12 — persisted user preferences governing how the app gates
/// access to its content. Today the only toggle is biometric-at-launch;
/// future additions (auto-lock-after-N-minutes, lock-on-screenshot,
/// etc.) live alongside.
///
/// The gate state itself lives in AppState (the in-memory latch),
/// not here — this object only owns the PERSISTED user choice.
/// AppState reads this on launch to decide the initial latch value.
@Observable
@MainActor
public final class PrivacySettings {
    private let defaults: UserDefaults
    private let requireBiometricKey = "flagship.privacy.requireBiometric"

    /// True if the user has opted in to requiring a Face ID / Touch ID
    /// evaluation each time the app cold-launches or returns from
    /// background. Default false — opt-in (we don't want to lock
    /// users out on first launch before they've seen the option).
    public var requireBiometricAtLaunch: Bool {
        didSet { defaults.set(requireBiometricAtLaunch, forKey: requireBiometricKey) }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.requireBiometricAtLaunch = defaults.bool(forKey: requireBiometricKey)
    }
}
