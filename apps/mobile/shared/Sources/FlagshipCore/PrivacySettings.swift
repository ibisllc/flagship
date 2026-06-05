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
    private let requirePassphraseKey = "flagship.privacy.requirePassphrase"

    /// True if a Face ID / Touch ID evaluation is required each time the
    /// app cold-launches or returns from background. Defaults to TRUE —
    /// a restored account opens behind a face-unlock rather than a full
    /// sign-in. Only gates once an account is paired (a first-ever launch
    /// with no account shows Welcome unguarded), and the device's own
    /// "Sign out" fallback covers a phone with no biometric enrolled. The
    /// user can turn this off in Settings → Privacy to open straight in.
    public var requireBiometricAtLaunch: Bool {
        didSet { defaults.set(requireBiometricAtLaunch, forKey: requireBiometricKey) }
    }

    /// The strictest option: when ON, the app does NOT restore the
    /// persisted session on launch, so every open requires a full
    /// sign-in (the account passphrase), not just a Face ID unlock.
    /// Default OFF — most users want to stay signed in behind Face ID.
    /// Supersedes `requireBiometricAtLaunch` when both are set (a full
    /// sign-in is strictly stronger than a face-unlock).
    public var requirePassphraseAtLaunch: Bool {
        didSet { defaults.set(requirePassphraseAtLaunch, forKey: requirePassphraseKey) }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Unset → default ON. Once the user makes an explicit choice we
        // honour the stored value.
        if defaults.object(forKey: requireBiometricKey) == nil {
            self.requireBiometricAtLaunch = true
        } else {
            self.requireBiometricAtLaunch = defaults.bool(forKey: requireBiometricKey)
        }
        // Unset → default OFF (opt-in to the slower, stricter mode).
        self.requirePassphraseAtLaunch = defaults.bool(forKey: requirePassphraseKey)
    }
}
