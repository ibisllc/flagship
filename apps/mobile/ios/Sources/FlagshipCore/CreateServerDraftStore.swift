import Foundation

/// Local, draft-only metadata fields the user can fill in before delivering an
/// InstallBlob. These are deliberately NOT signed into the InstallBlob (the
/// audit confirmed `backupPolicy` and `llmPreferences` do not appear in the
/// canonical bytes), so they live only on this device and only as user intent.
///
/// They mirror the webapp's draft schema in
/// `apps/web/public/webapp/lib/buildDraft.js`:
///   - `backupPolicy`     ∈ {"none", "phone-only", "peer"}, default "phone-only"
///   - `llmPreferences`   free-text on iOS (the webapp parses `provider:model`
///                        lines into a structured array; on iOS the user note
///                        is stored as written so we don't fork the UX).
///
/// Persistence is `UserDefaults`. Same store as `BootUnlockStore` — non-secret,
/// device-local. There is one in-flight draft at a time (the create-server
/// flow is single-instance), so we don't key by an id; resuming the screen
/// after dismissal restores the last values the user typed.
public struct CreateServerDraftStore {
    public enum BackupPolicy: String, Sendable, Hashable, CaseIterable {
        /// No automatic backup. Power-user opt-out.
        case none
        /// Phone-side scheduled pull; the default. Mirrors the webapp default.
        case phoneOnly = "phone-only"
        /// Peer-backup distribution to other Flagship users.
        case peer
    }

    private let defaults: UserDefaults
    private static let backupPolicyKey = "flagship.createServerDraft.backupPolicy"
    private static let llmPrefsKey = "flagship.createServerDraft.llmPreferences"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public func backupPolicy() -> BackupPolicy {
        guard let raw = defaults.string(forKey: Self.backupPolicyKey),
              let v = BackupPolicy(rawValue: raw) else {
            return .phoneOnly
        }
        return v
    }

    public func setBackupPolicy(_ policy: BackupPolicy) {
        defaults.set(policy.rawValue, forKey: Self.backupPolicyKey)
    }

    public func llmPreferences() -> String {
        defaults.string(forKey: Self.llmPrefsKey) ?? ""
    }

    public func setLlmPreferences(_ note: String) {
        if note.isEmpty {
            defaults.removeObject(forKey: Self.llmPrefsKey)
        } else {
            defaults.set(note, forKey: Self.llmPrefsKey)
        }
    }

    /// Wipe both fields back to their defaults. Called after a successful
    /// delivery so the next "Add a server" doesn't ghost-restore yesterday's
    /// inputs onto a fresh build.
    public func reset() {
        defaults.removeObject(forKey: Self.backupPolicyKey)
        defaults.removeObject(forKey: Self.llmPrefsKey)
    }
}
