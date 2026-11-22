import Foundation
import Observation

/// Home's recovery reminders (owner, 2026-11-21: no backup page after
/// creating an account; Home reminds instead). Two cards, one at a time:
///
///   1. cloud recovery, while it isn't set up;
///   2. a backup file, once the cloud card was put off and there is still
///      neither cloud recovery nor a saved backup file on this device.
///
/// Their x snoozes the card for a week rather than hiding it for good: an
/// account with no way back in is worth asking about again. Mirrors the
/// webapp (views/home.js `homeReminder`) and Android's RecoveryBannerStore.
/// UI only: the truth that recovery is set up is AppState.hasCloudRecovery,
/// and a saved file is KeyBackupState.
@Observable
@MainActor
public final class RecoveryBannerStore {
    public nonisolated static let snooze: TimeInterval = 7 * 24 * 60 * 60

    private let defaults: UserDefaults
    private let now: () -> Date
    private static let legacyDismissedKey = "flagship.recoveryBanner.dismissed.v1"
    private static let dismissedAtKey = "flagship.recoveryBanner.dismissedAt.v2"
    private static let backupFileDismissedAtKey = "flagship.backupFileReminder.dismissedAt.v1"

    /// When the cloud recovery card was last put off.
    public private(set) var dismissedAt: Date? {
        didSet { Self.store(dismissedAt, Self.dismissedAtKey, defaults) }
    }

    /// When the backup file card was last put off.
    public private(set) var backupFileDismissedAt: Date? {
        didSet { Self.store(backupFileDismissedAt, Self.backupFileDismissedAtKey, defaults) }
    }

    public init(defaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.now = now
        var at = Self.load(Self.dismissedAtKey, defaults)
        // A dismissal from before the snooze counts as put off from today.
        if at == nil, defaults.bool(forKey: Self.legacyDismissedKey) {
            at = now()
            Self.store(at, Self.dismissedAtKey, defaults)
        }
        defaults.removeObject(forKey: Self.legacyDismissedKey)
        self.dismissedAt = at
        self.backupFileDismissedAt = Self.load(Self.backupFileDismissedAtKey, defaults)
    }

    /// The cloud recovery card is snoozed right now. Setting it puts the card
    /// off for a week (true) or brings it back (false).
    public var dismissed: Bool {
        get { Self.isSnoozed(dismissedAt, now: now()) }
        set { dismissedAt = newValue ? now() : nil }
    }

    /// The backup file card is snoozed right now.
    public var backupFileDismissed: Bool {
        get { Self.isSnoozed(backupFileDismissedAt, now: now()) }
        set { backupFileDismissedAt = newValue ? now() : nil }
    }

    public nonisolated static func isSnoozed(_ at: Date?, now: Date) -> Bool {
        guard let at else { return false }
        return now.timeIntervalSince(at) < snooze
    }

    /// The cloud recovery card: recovery isn't set up and the card isn't snoozed.
    public nonisolated static func shouldShow(hasCloudRecovery: Bool, dismissed: Bool) -> Bool {
        !hasCloudRecovery && !dismissed
    }

    /// The backup file card: the cloud card was put off (it is snoozed), and
    /// this account still has neither cloud recovery nor a backup file saved
    /// from this device, and this card isn't snoozed itself.
    public nonisolated static func shouldShowBackupFile(hasCloudRecovery: Bool, recoverySnoozed: Bool,
                                                        hasBackupFile: Bool, dismissed: Bool) -> Bool {
        !hasCloudRecovery && recoverySnoozed && !hasBackupFile && !dismissed
    }

    private static func load(_ key: String, _ d: UserDefaults) -> Date? {
        d.object(forKey: key) == nil ? nil : Date(timeIntervalSince1970: d.double(forKey: key))
    }

    private static func store(_ date: Date?, _ key: String, _ d: UserDefaults) {
        if let date { d.set(date.timeIntervalSince1970, forKey: key) } else { d.removeObject(forKey: key) }
    }
}
