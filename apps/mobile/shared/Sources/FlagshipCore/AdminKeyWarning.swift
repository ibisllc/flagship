import Foundation
import Observation
import FlagshipAPI

/// Never push anyone to destroy the key that can still save their data
/// (docs/account-gone.md "The admin key is the way out: exact strings").
///
/// The account's admin key on this device is the person's only reliable way
/// to save their servers' data: a hostile or vanished `.com` can cut the
/// passkey recovery route, and it can say the account does not exist, but it
/// cannot take the key from the device. So anything that removes it (Remove
/// it from this device and Create a new account on the "account was removed"
/// screen, Sign out and Remove this device in Settings) first says so, in
/// plain words, and offers to save first. The strings are the webapp's
/// (`lib/adminKeyWarning.js`), with the phone variants ("device"). The rescue
/// flow ("Save my servers' data") is not part of this build: the way out is a
/// backup of the account key.
public enum AdminKeyCopy {
    /// Removing the account's keys from this device.
    public static let removeTitle = String(localized: "Remove this account from this device?")
    public static let removeMessage =
        String(localized: "This also removes this device's admin key, which you need to sign in to your servers. Save a backup of your account key first, or remove anyway.")
    public static let saveFirst = String(localized: "Save my account key first")
    public static let removeAnyway = String(localized: "Remove anyway")
    /// Settings, Sign out, on an admin device.
    public static let signOutTitle = String(localized: "Sign out?")
    public static let signOutMessage =
        String(localized: "Signing out removes this device's admin key. Save a backup of your account key first, or sign out anyway.")
    public static let signOutAnyway = String(localized: "Sign out anyway")
    /// The same, once this device has written an account-key file.
    public static let signOutBackedUpMessage =
        String(localized: "Signing out removes this device's admin key. You backed up your account key, so keep that file and its passphrase safe.")
    public static let signOutBackedUpOk = String(localized: "Sign out")
    public static let cancel = "Cancel"
    /// Shown when a save-first path needs the key unlocked.
    public static let unlockFirst = String(localized: "Unlock first to save your key.")
}

public struct AdminKeyWarning: Equatable, Sendable {
    public enum Role: Equatable, Sendable { case save, go, cancel }
    public struct Choice: Equatable, Sendable {
        public let role: Role
        public let label: String
    }
    public let title: String
    public let message: String
    public let choices: [Choice]

    /// Sign out's confirm: what to say and which buttons, given whether this
    /// device wrote an account-key file.
    public static func signOut(backedUp: Bool) -> AdminKeyWarning {
        if backedUp {
            return AdminKeyWarning(
                title: AdminKeyCopy.signOutTitle, message: AdminKeyCopy.signOutBackedUpMessage,
                choices: [.init(role: .cancel, label: AdminKeyCopy.cancel), .init(role: .go, label: AdminKeyCopy.signOutBackedUpOk)]
            )
        }
        return AdminKeyWarning(
            title: AdminKeyCopy.signOutTitle, message: AdminKeyCopy.signOutMessage,
            choices: [.init(role: .save, label: AdminKeyCopy.saveFirst), .init(role: .go, label: AdminKeyCopy.signOutAnyway)]
        )
    }

    /// The remove confirm: always the same words, save first or remove anyway.
    public static let remove = AdminKeyWarning(
        title: AdminKeyCopy.removeTitle, message: AdminKeyCopy.removeMessage,
        choices: [.init(role: .save, label: AdminKeyCopy.saveFirst), .init(role: .go, label: AdminKeyCopy.removeAnyway)]
    )

    /// Does this device hold a key that can still save a server's data: the
    /// account's admin root (in memory, or the sealed record) or a session
    /// for any server? A demo account holds no keys (its operator runs it).
    public static func holdsRescueKey(isDemoAccount: Bool, hasAdminRoot: Bool, serverSessionCount: Int) -> Bool {
        if isDemoAccount { return false }
        return hasAdminRoot || serverSessionCount > 0
    }
}

/// Whether this device wrote an account-key file (`.flagshipkey`), per
/// account: set when the export's share sheet finishes, read by Sign out.
public enum KeyBackupState {
    private static func key(_ username: String) -> String { "flagship.keyBackup.at.\(username.lowercased())" }

    public static func record(username: String, at date: Date = Date(), defaults: UserDefaults = .standard) {
        guard !username.isEmpty else { return }
        defaults.set(date.timeIntervalSince1970, forKey: key(username))
    }

    public static func hasBackup(username: String, defaults: UserDefaults = .standard) -> Bool {
        !username.isEmpty && defaults.object(forKey: key(username)) != nil
    }

    public static func forget(username: String, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key(username))
    }
}

/// The "account was removed" state of this install, for the screen and the
/// pollers. Detection lives in `AccountGoneRegistry`.
@MainActor
@Observable
public final class AccountGoneCenter {
    public private(set) var goneName: String?
    @ObservationIgnored private let registry: AccountGoneRegistry

    public init(registry: AccountGoneRegistry = .shared) {
        self.registry = registry
        goneName = registry.goneName
        registry.onChange { [weak self] name in
            Task { @MainActor in self?.goneName = name }
        }
    }

    public var isGone: Bool { goneName != nil }

    /// Tell the detector which names are this device's own.
    public func setOwnNames(_ names: [String?]) { registry.setOwnNames(names) }

    /// The person removed it from this device.
    public func clear() {
        registry.clear()
        goneName = nil
    }
}
