import Foundation
import Observation

/// "Your watch is waiting": set when the watch's Approve reached a phone
/// whose app session holds no account key yet, so the app, once it is in
/// front, can ask the owner to unlock it. The prompt only asks; the owner's
/// own tap opens Face ID, never this, and the approval stays the
/// delegate-key signature the watch's next Approve produces.
@MainActor
@Observable
public final class WatchApprovalPrompt {
    public static let shared = WatchApprovalPrompt()

    /// A boot request lives a few minutes; an older ask is not worth raising.
    public static let lifetime: TimeInterval = 5 * 60

    public struct Waiting: Equatable, Sendable {
        /// The box the watch asked about, when the phone knows it.
        public let serverFqdn: String?
        public let at: Date
    }

    public private(set) var waiting: Waiting?

    @ObservationIgnored private let now: () -> Date

    public init(now: @escaping () -> Date = Date.init) {
        self.now = now
    }

    public func watchIsWaiting(serverFqdn: String?) {
        waiting = Waiting(serverFqdn: (serverFqdn?.isEmpty == false) ? serverFqdn : nil, at: now())
    }

    /// The ask still worth showing, or nil once answered or expired.
    public var current: Waiting? {
        guard let waiting, now().timeIntervalSince(waiting.at) < Self.lifetime else { return nil }
        return waiting
    }

    public func clear() {
        waiting = nil
    }

    /// Ask in the app only while it is in front, past its lock screen and
    /// still without the session's account key.
    public func shouldAsk(inFront: Bool, appUnlocked: Bool, hasSessionKey: Bool) -> Bool {
        inFront && appUnlocked && !hasSessionKey && current != nil
    }

    public static let title = String(localized: "Your Apple Watch is waiting")
    public static let afterUnlock = String(localized: "Unlocked. Tap Approve on your watch again.")
    public static let lockScreenNote = String(localized: "Your Apple Watch is waiting to approve a server's start-up. Unlock, then tap Approve on the watch again.")

    public static func message(serverName: String?) -> String {
        let what = serverName.map { String(localized: "\($0)'s start-up") } ?? "a server's start-up"
        return String(localized: "Your watch asked to approve \(what). Unlock Flagship once so it can, then tap Approve on the watch again.")
    }
}
