import Foundation
import Observation

/// Backs the **Secure your account** step of create-onboarding.
///
/// Inserted right after an account/identity is opened (OpenAccount) and
/// before the user lands in the main app. It offers two independent
/// backups, cloud and a backup file, both unchecked at first: the person
/// ticks either, both, or skips behind a clear warning.
///
/// This VM owns ONLY the two ticks, the skip-confirmation state and the
/// iCloud-availability detection. The two backup mechanisms it routes to
/// are the EXISTING ones:
///   - cloud  → the WebAuthn-PRF cloud recovery (RecoveryViewModel),
///   - file   → the `.flagshipkey` export (KeyfileExportViewModel /
///     KeyfileExportScreen).
/// Nothing here is rebuilt; the screen wires those in.
@Observable
@MainActor
public final class SecureAccountViewModel {
    /// Cloud backup is ticked. Only ever true while iCloud is available.
    public private(set) var cloudSelected: Bool = false

    /// Save a backup file is ticked.
    public private(set) var fileSelected: Bool = false

    /// Whether iCloud is reachable for this device/account. When false
    /// the cloud row is shown disabled with a hint.
    public let iCloudAvailable: Bool

    /// Drives the "Skip for now" confirmation, shown from the Skip button.
    public var showSkipConfirm: Bool = false

    /// Detects iCloud availability via the iCloud ubiquity token — the
    /// standard, entitlement-safe signal for "is the user signed into
    /// iCloud". Returns false (never crashes / blocks) when iCloud is off.
    public nonisolated static func detectICloudAvailable() -> Bool {
        FileManager.default.ubiquityIdentityToken != nil
    }

    public init(iCloudAvailable: Bool = SecureAccountViewModel.detectICloudAvailable()) {
        self.iCloudAvailable = iCloudAvailable
    }

    /// The cloud row is tickable only when iCloud is available.
    public var canSelectCloud: Bool { iCloudAvailable }

    /// Continue runs every ticked backup, so it needs at least one.
    public var canContinue: Bool { cloudSelected || fileSelected }

    /// Tick or untick cloud backup (no-op when iCloud is unavailable).
    public func toggleCloud() {
        guard canSelectCloud else { return }
        cloudSelected.toggle()
    }

    /// Tick or untick the backup file.
    public func toggleFile() {
        fileSelected.toggle()
    }

    /// Begin the skip flow — surfaces the confirmation.
    public func requestSkip() {
        showSkipConfirm = true
    }

    /// Dismiss the skip confirmation without skipping ("Back").
    public func cancelSkip() {
        showSkipConfirm = false
    }
}
