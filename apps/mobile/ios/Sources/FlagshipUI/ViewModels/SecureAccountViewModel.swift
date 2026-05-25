import Foundation
import Observation

/// Backs the **Secure your account** step of create-onboarding.
///
/// Inserted right after an account/identity is opened (OpenAccount) and
/// before the user lands in the main app. It nudges the user to back up
/// the account they just created, with the cloud option pre-selected,
/// while letting them skip behind a clear warning.
///
/// This VM owns ONLY the small selection + skip-confirmation state and
/// the iCloud-availability detection. The two backup mechanisms it routes
/// to are the EXISTING ones:
///   - cloud  → the WebAuthn-PRF cloud recovery (RecoveryViewModel),
///   - file   → the `.flagshipkey` export (KeyfileExportViewModel /
///     KeyfileExportScreen).
/// Nothing here is rebuilt; the screen wires those in.
@Observable
@MainActor
public final class SecureAccountViewModel {
    /// The three mutually-exclusive choices on the step. `none` is the
    /// pre-selected value only when iCloud is unavailable (so the user
    /// still has file + skip).
    public enum Option: Equatable, Sendable {
        case cloud
        case file
    }

    /// The current selection. Starts pre-selected with `.cloud` when
    /// iCloud is available, otherwise `nil` (nothing pre-selected).
    public var selected: Option?

    /// Whether iCloud is reachable for this device/account. When false
    /// the cloud row is shown disabled with a hint and never pre-selected.
    public let iCloudAvailable: Bool

    /// Drives the "Skip for now" confirmation sheet.
    public var showSkipConfirm: Bool = false

    /// Detects iCloud availability via the iCloud ubiquity token — the
    /// standard, entitlement-safe signal for "is the user signed into
    /// iCloud". Returns false (never crashes / blocks) when iCloud is off.
    public nonisolated static func detectICloudAvailable() -> Bool {
        FileManager.default.ubiquityIdentityToken != nil
    }

    public init(iCloudAvailable: Bool = SecureAccountViewModel.detectICloudAvailable()) {
        self.iCloudAvailable = iCloudAvailable
        // Pre-select the cloud option ONLY when iCloud is available.
        // When it's off we pre-select nothing; the step still works via
        // the file option or skip.
        self.selected = iCloudAvailable ? .cloud : nil
    }

    /// The cloud row is selectable only when iCloud is available.
    public var canSelectCloud: Bool { iCloudAvailable }

    /// Continue acts on the current selection. Enabled whenever SOMETHING
    /// is selected (cloud only when available — `selected` can't be
    /// `.cloud` if it isn't, since selecting it is gated).
    public var canContinue: Bool { selected != nil }

    /// Select the cloud option (no-op when iCloud is unavailable).
    public func selectCloud() {
        guard canSelectCloud else { return }
        selected = .cloud
    }

    /// Select the file-backup option.
    public func selectFile() {
        selected = .file
    }

    /// Begin the skip flow — surfaces the confirmation sheet.
    public func requestSkip() {
        showSkipConfirm = true
    }

    /// Dismiss the skip confirmation without skipping ("Back").
    public func cancelSkip() {
        showSkipConfirm = false
    }
}
