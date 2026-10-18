import Foundation

/// The routing key (RCK) a pending order for a name was minted with.
///
/// `.com` pins a name to the first RCK registered for it. Every mint used to
/// make a new random key, so a retry, a reconnect after the builder's socket
/// dropped or a second tap on the same order was refused with
/// `409 subdomain already controlled by a different RCK` and left the first
/// registration orphaned. A mint for a name that still has a recent pending key
/// reuses that key, so registering it again is the same claim.
///
/// Only the PUBLIC key is kept: the phone holds no RCK secret, nothing here is
/// sensitive, and a stale entry can never block a name (a released name accepts
/// any key). Mirrors Android's `PendingRckStore`.
public struct PendingRckStore {
    private let defaults: UserDefaults
    private let now: () -> Date
    private static let prefix = "flagship.pendingRck."

    /// A recipe lives at most 24 hours (the longest TTL the wizard offers).
    public static let ttl: TimeInterval = 24 * 60 * 60

    public init(defaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.now = now
    }

    private static func key(_ serverDomain: String) -> String {
        prefix + serverDomain.lowercased()
    }

    /// The key to mint with for `serverDomain`: the pending one when it is
    /// still fresh, otherwise `fresh()`, which is then remembered.
    public func reuseOrRecord(for serverDomain: String, fresh: () -> String) -> String {
        let k = Self.key(serverDomain)
        if let saved = defaults.string(forKey: k) {
            let parts = saved.split(separator: "|", maxSplits: 1).map(String.init)
            if parts.count == 2, !parts[0].isEmpty, let at = TimeInterval(parts[1]) {
                let age = now().timeIntervalSince1970 - at
                if age >= 0, age <= Self.ttl { return parts[0] }
            }
        }
        let pub = fresh()
        defaults.set("\(pub)|\(Int(now().timeIntervalSince1970))", forKey: k)
        return pub
    }

    /// The order was cancelled or its server registered: forget the key.
    public func clear(for serverDomain: String) {
        defaults.removeObject(forKey: Self.key(serverDomain))
    }
}
