import Foundation
import Observation

/// Home's pointer to the account's voi.ci page (docs/voici-and-messages.md §11). The page itself is managed at the top
/// of the Messages tab; Home only points there: a welcome card until the page was first made public or the person
/// tapped its x, then a compact "Your page" row that stays. Both are kept per account on this device. Same rule as the
/// webapp's home pointer and Android's PageWelcomeCardStore.
@Observable
@MainActor
public final class PageWelcomeCardStore {
    public enum Pointer: Equatable, Sendable {
        case hidden
        case welcome
        /// The compact row; `isPublic` says what its status reads.
        case row(isPublic: Bool)
    }

    private let defaults: UserDefaults
    /// Changes made in this process, so Home re-renders at once.
    private var dismissedNow: Set<String> = []
    private var publishedNow: Set<String> = []

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public nonisolated static func key(_ username: String) -> String { "flagship.voici.welcome.dismissed.v1.\(username.lowercased())" }
    public nonisolated static func publishedKey(_ username: String) -> String { "flagship.voici.welcome.everPublished.v1.\(username.lowercased())" }

    public func isDismissed(username: String?) -> Bool {
        guard let u = username?.lowercased(), !u.isEmpty else { return true }
        return dismissedNow.contains(u) || defaults.bool(forKey: Self.key(u))
    }

    public func dismiss(username: String?) {
        guard let u = username?.lowercased(), !u.isEmpty else { return }
        defaults.set(true, forKey: Self.key(u))
        dismissedNow.insert(u)
    }

    /// The page was public at least once on this account (seen from this device).
    public func everPublished(username: String?) -> Bool {
        guard let u = username?.lowercased(), !u.isEmpty else { return false }
        return publishedNow.contains(u) || defaults.bool(forKey: Self.publishedKey(u))
    }

    public func notePublished(username: String?) {
        guard let u = username?.lowercased(), !u.isEmpty, !everPublished(username: u) else { return }
        defaults.set(true, forKey: Self.publishedKey(u))
        publishedNow.insert(u)
    }

    /// The page store calls this whenever it holds a public index for the account.
    public nonisolated static func recordPublished(username: String, defaults: UserDefaults = .standard) {
        guard !username.isEmpty else { return }
        defaults.set(true, forKey: publishedKey(username))
    }

    /// - Parameters:
    ///   - hasAccount: the account can have a page (a real account, not a sample one).
    ///   - checked: the page was read from `.com` at least once, so "no page" is known, not a failed read.
    ///   - published: `.com` holds a published page for the account.
    ///   - pendingChanges: edits made on any device and not yet published (the person already found the page).
    public nonisolated static func shouldShow(hasAccount: Bool, checked: Bool, published: Bool, pendingChanges: Int, dismissed: Bool) -> Bool {
        hasAccount && checked && !published && pendingChanges == 0 && !dismissed
    }

    /// The welcome card until the page was first public, changes were started, or the card was dismissed; the row after.
    /// A sample account (`sampleAccount`) always gets the row once its page was read: its page is the operator's example,
    /// so there is nothing to set up and no welcome card.
    public nonisolated static func pointer(hasAccount: Bool, checked: Bool, published: Bool, everPublished: Bool, pendingChanges: Int, dismissed: Bool,
                                           sampleAccount: Bool = false) -> Pointer {
        if sampleAccount { return checked ? .row(isPublic: published) : .hidden }
        guard hasAccount, checked else { return .hidden }
        if shouldShow(hasAccount: hasAccount, checked: checked, published: published || everPublished, pendingChanges: pendingChanges, dismissed: dismissed) {
            return .welcome
        }
        return .row(isPublic: published)
    }
}

/// The one-time "Everything you put on your page is public" warning, remembered per account on this device. Turning the
/// page public (the Public switch, or Publish while the page is not public) never skips it: `next` names the step.
public final class PagePublicWarning: @unchecked Sendable {
    public enum Step: Equatable, Sendable {
        /// Not an admin device: nothing is signed here.
        case refuse
        /// The page and message rules first (once per device), then the warning.
        case rules
        case warning
        case publish
    }

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public static func key(_ username: String) -> String { "flagship.voici.publicWarning.v1.\(username.lowercased())" }

    public func acknowledged(username: String?) -> Bool {
        guard let u = username?.lowercased(), !u.isEmpty else { return false }
        return defaults.bool(forKey: Self.key(u))
    }

    /// Only after "Make it public" was tapped.
    public func acknowledge(username: String?) {
        guard let u = username?.lowercased(), !u.isEmpty else { return }
        defaults.set(true, forKey: Self.key(u))
    }

    public static func next(isAdmin: Bool, rulesAccepted: Bool, acknowledged: Bool) -> Step {
        guard isAdmin else { return .refuse }
        if !rulesAccepted { return .rules }
        return acknowledged ? .publish : .warning
    }
}
