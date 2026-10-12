import Foundation
import FlagshipAPI

/// An update order this device sent that the box hasn't reported on yet.
/// Device-local: it only stops the update card from offering the button again
/// (and a duplicate order) while the box is still picking the first one up.
public struct PendingUpdateOrder: Codable, Equatable, Sendable {
    public var targetCommit: String
    public var targetTag: String?
    public var fromCommit: String
    /// Phone clock, ms since the epoch.
    public var orderedAt: Int64

    public init(targetCommit: String, targetTag: String? = nil, fromCommit: String, orderedAt: Int64) {
        self.targetCommit = targetCommit.lowercased()
        self.targetTag = targetTag.flatMap { $0.isEmpty ? nil : $0 }
        self.fromCommit = fromCommit.lowercased()
        self.orderedAt = orderedAt
    }

    /// "v1.4.0", else the short commit.
    public var targetLabel: String { targetTag ?? String(targetCommit.prefix(8)) }

    /// The box has shown the outcome: it runs the target, or its last-update
    /// record names the target and is no older than the order (applied,
    /// rolled back or refused; the card's "last update" line explains which).
    /// Boxes without `lastUpdate` only resolve through `currentCommit`.
    public func isResolved(currentCommit: String?, lastUpdate: LastUpdate?) -> Bool {
        if currentCommit?.lowercased() == targetCommit { return true }
        if let lu = lastUpdate, lu.targetCommit?.lowercased() == targetCommit, lu.at >= orderedAt { return true }
        // A refusal names no target (the box records only why), so any refusal
        // after the order is the answer to it.
        if let lu = lastUpdate, lu.outcome == "refused", lu.targetCommit == nil, lu.at >= orderedAt { return true }
        return false
    }

    public static let staleAfterMs: Int64 = 30 * 60 * 1000

    public func isStale(now: Int64) -> Bool { now - orderedAt >= Self.staleAfterMs }

    public func sentCopy(now: Int64) -> String {
        "Update to \(targetLabel) sent \(Self.ago(ms: now - orderedAt)). The server picks it up within about five minutes, restarts, and goes back on its own if the new version doesn't start."
    }

    public static let staleCopy = "The server hasn't applied this update yet. It may be offline."

    static func ago(ms: Int64) -> String {
        let s = max(0, ms / 1000)
        if s < 60 { return "just now" }
        let m = s / 60
        if m < 60 { return m == 1 ? "1 minute ago" : "\(m) minutes ago" }
        let h = m / 60
        if h < 24 { return h == 1 ? "1 hour ago" : "\(h) hours ago" }
        let d = h / 24
        return d == 1 ? "1 day ago" : "\(d) days ago"
    }
}

/// What the update card shows for this server right now.
public enum UpdateCardMode: Equatable, Sendable {
    /// No order outstanding: the normal update button.
    case ready
    /// An order is on its way; the button is hidden.
    case pending(PendingUpdateOrder)
    /// 30 minutes and no outcome: offer Send again / Forget it.
    case stale(PendingUpdateOrder)

    public init(pending: PendingUpdateOrder?, now: Int64) {
        guard let pending else { self = .ready; return }
        self = pending.isStale(now: now) ? .stale(pending) : .pending(pending)
    }

    public var showsUpdateButton: Bool { self == .ready }
}

/// Per-server pending update orders, in UserDefaults. Non-secret (commits and
/// a timestamp). A storage failure reads as "no order pending", which only
/// means the button comes back.
public struct PendingUpdateStore {
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private func key(_ fqdn: String) -> String {
        "flagship.pendingUpdate.\(fqdn.lowercased())"
    }

    public func load(serverFqdn: String) -> PendingUpdateOrder? {
        guard let data = defaults.data(forKey: key(serverFqdn)) else { return nil }
        return try? JSONDecoder().decode(PendingUpdateOrder.self, from: data)
    }

    public func save(_ order: PendingUpdateOrder, serverFqdn: String) {
        guard let data = try? JSONEncoder().encode(order) else { return }
        defaults.set(data, forKey: key(serverFqdn))
    }

    public func clear(serverFqdn: String) {
        defaults.removeObject(forKey: key(serverFqdn))
    }

    /// Drops the order once the box has reported its outcome; returns what is
    /// still pending.
    @discardableResult
    public func reconcile(serverFqdn: String, currentCommit: String?, lastUpdate: LastUpdate?) -> PendingUpdateOrder? {
        guard let order = load(serverFqdn: serverFqdn) else { return nil }
        if order.isResolved(currentCommit: currentCommit, lastUpdate: lastUpdate) {
            clear(serverFqdn: serverFqdn)
            return nil
        }
        return order
    }
}
