import Foundation
import Observation

/// The red counts on the Social page (docs/social-tabs.md): Profile, Inbox, Requests, the floating call button, and
/// their total on the Social tab in the tab bar. Every count comes from what the app already holds; the two "seen"
/// markers (calls, profile) are this device's own, kept per account in the app's defaults and never sent anywhere.
@MainActor
@Observable
public final class SocialBadges {
    public static let shared = SocialBadges()

    @ObservationIgnored private let store: MessagesStore
    @ObservationIgnored private let history: VoiciCallHistory
    @ObservationIgnored private let defaults: UserDefaults
    /// Bumped when a marker moves, so views reading the counts redraw.
    private var markerVersion = 0

    init(store: MessagesStore = .shared, history: VoiciCallHistory = .shared, defaults: UserDefaults = .standard) {
        self.store = store
        self.history = history
        self.defaults = defaults
    }

    nonisolated static func callsSeenKey(_ u: String) -> String { "flagship.social.callsSeenAt.\(u.lowercased())" }
    nonisolated static func profileSeenKey(_ u: String) -> String { "flagship.social.profileSeenAt.\(u.lowercased())" }

    private var live: Bool { store.hasAccount && !store.isSampleReadOnly }

    /// New comments and reactions on the owner's posts. Comments and reactions are not built yet (docs/social-tab.md
    /// §3.3), so this is 0 until they are; the seen marker is already kept so the count can start from it.
    public var profile: Int {
        _ = markerVersion
        return 0
    }

    /// Conversations with an unread message, requests left out (they have their own count).
    public var inbox: Int { live ? store.accepted.filter(store.isUnread).count : 0 }

    /// Message requests waiting for a reply or an accept.
    public var requests: Int { live ? store.requests.count : 0 }

    /// Missed calls (this device's and the page's) newer than the last time the Calls page was open.
    public var missedCalls: Int {
        _ = markerVersion
        guard live else { return 0 }
        let seen = seenAt(Self.callsSeenKey(store.username))
        return Self.unseenMissed(history.entries(missed: store.missedCalls), seenAt: seen)
    }

    public var total: Int { profile + inbox + requests + missedCalls }

    nonisolated static func unseenMissed(_ entries: [VoiciCallRecord], seenAt: Int64) -> Int {
        entries.filter { $0.direction == .incoming && $0.outcome == .missed && $0.at > seenAt }.count
    }

    /// The Calls page opened (and closed): every missed call so far counts as seen.
    public func callsSeen() { mark(Self.callsSeenKey(store.username)) }

    /// The Profile tab showed.
    public func profileSeen() { mark(Self.profileSeenKey(store.username)) }

    private func seenAt(_ key: String) -> Int64 { Int64(defaults.double(forKey: key)) }

    private func mark(_ key: String) {
        guard !store.username.isEmpty else { return }
        defaults.set(Double(store.now()), forKey: key)
        markerVersion += 1
    }

    /// The account left this device.
    nonisolated static func forget(username: String?, allProfiles: Bool, defaults: UserDefaults = .standard) {
        if allProfiles {
            for k in defaults.dictionaryRepresentation().keys where k.hasPrefix("flagship.social.") { defaults.removeObject(forKey: k) }
        } else if let u = username, !u.isEmpty {
            defaults.removeObject(forKey: callsSeenKey(u))
            defaults.removeObject(forKey: profileSeenKey(u))
        }
    }
}
