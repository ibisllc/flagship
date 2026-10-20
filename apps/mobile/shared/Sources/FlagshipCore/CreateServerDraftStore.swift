import Foundation
import FlagshipAPI

/// What the user picked on the create form before delivering an InstallBlob.
/// Not part of the InstallBlob's signed bytes: the backup policy is signed
/// on its own (`flagship/backup-policy/v1`) and rides beside the pairing
/// order (`ServerBackupFormat.attachBackupPolicy`).
///
/// Mirrors the webapp's draft schema in
/// `apps/web/public/webapp/lib/buildDraft.js`:
///   - `backupPolicy`     ∈ {"none", "phone-only", "peer"}, default "phone-only"
///
/// Persistence is `UserDefaults`. Same store as `BootUnlockStore` — non-secret,
/// device-local. There is one in-flight draft at a time (the create-server
/// flow is single-instance), so we don't key by an id; resuming the screen
/// after dismissal restores the last values the user typed.
public struct CreateServerDraftStore {
    public enum BackupPolicy: String, Sendable, Hashable, CaseIterable {
        /// No automatic backup. Power-user opt-out.
        case none
        /// Phone-side scheduled pull. Never a default: the owner picks.
        case phoneOnly = "phone-only"
        /// Peer-backup distribution to other Flagship users.
        case peer
    }

    private let defaults: UserDefaults
    private static let backupPolicyKey = "flagship.createServerDraft.backupPolicy"
    private static let phoneReserveKey = "flagship.createServerDraft.phoneReserveBytes"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// The owner's pick, or nil until they have made one (nothing is
    /// preselected, and creating a server stays off until they do).
    public func backupPolicy() -> BackupPolicy? {
        // A saved "peer" pick is dropped while backups on other servers are off, so an old draft
        // can't create a Peer server (the box refuses it too).
        defaults.string(forKey: Self.backupPolicyKey).flatMap(BackupPolicy.init(rawValue:))
            .flatMap { $0 == .peer && !BackupFeatures.peerBackup ? nil : $0 }
    }

    public func setBackupPolicy(_ policy: BackupPolicy?) {
        if let policy { defaults.set(policy.rawValue, forKey: Self.backupPolicyKey) } else {
            defaults.removeObject(forKey: Self.backupPolicyKey)
        }
    }

    /// The space the phone keeps for a phone-side server's backup, or nil
    /// (the picker then offers its default).
    public func phoneReserveBytes() -> Int64? {
        let v = defaults.object(forKey: Self.phoneReserveKey) as? NSNumber
        return v.map { $0.int64Value }.flatMap { $0 > 0 ? $0 : nil }
    }

    public func setPhoneReserveBytes(_ bytes: Int64?) {
        if let bytes, bytes > 0 { defaults.set(NSNumber(value: bytes), forKey: Self.phoneReserveKey) } else {
            defaults.removeObject(forKey: Self.phoneReserveKey)
        }
    }

    /// Wipe the draft back to defaults. Called after a successful delivery so
    /// the next "Add a server" doesn't ghost-restore yesterday's inputs onto a
    /// fresh build.
    public func reset() {
        defaults.removeObject(forKey: Self.backupPolicyKey)
        defaults.removeObject(forKey: Self.phoneReserveKey)
    }
}
