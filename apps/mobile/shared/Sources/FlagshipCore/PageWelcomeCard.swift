import Foundation
import Observation

/// Home's welcome card that introduces the account's voi.ci page (docs/voici-and-messages.md §11). It shows until
/// the account has a page (published, or a change waiting to be) or the person dismisses it; the dismissal is kept
/// per account on this device. Same rule as the webapp's `shouldShowPageWelcome` and Android's PageWelcomeCard.
@Observable
@MainActor
public final class PageWelcomeCardStore {
    private let defaults: UserDefaults
    /// Accounts dismissed in this process, so Home re-renders at once.
    private var dismissedNow: Set<String> = []

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public static func key(_ username: String) -> String { "flagship.voici.welcome.dismissed.v1.\(username.lowercased())" }

    public func isDismissed(username: String?) -> Bool {
        guard let u = username?.lowercased(), !u.isEmpty else { return true }
        return dismissedNow.contains(u) || defaults.bool(forKey: Self.key(u))
    }

    public func dismiss(username: String?) {
        guard let u = username?.lowercased(), !u.isEmpty else { return }
        defaults.set(true, forKey: Self.key(u))
        dismissedNow.insert(u)
    }

    /// - Parameters:
    ///   - hasAccount: the account can have a page (a real account, not a sample one).
    ///   - checked: the page was read from `.com` at least once, so "no page" is known, not a failed read.
    ///   - published: `.com` holds a published page for the account.
    ///   - pendingChanges: edits made on any device and not yet published (the person already found the editor).
    public static func shouldShow(hasAccount: Bool, checked: Bool, published: Bool, pendingChanges: Int, dismissed: Bool) -> Bool {
        hasAccount && checked && !published && pendingChanges == 0 && !dismissed
    }
}
