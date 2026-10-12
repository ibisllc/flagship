import Foundation

/// Which owner AID each box we were invited to belongs to (docs/app-apis.md §5).
///
/// Invites bind the friend's PER-AUTHOR contact AID, `deriveContactAccountId(
/// UMK, ownerAID)`, so a knock on that box must sign with the same contact AID
/// or the box answers 401. The knock link carries no owner AID (the knock page
/// discloses nothing about the owner), so the owner AID from the invite link's
/// `a=` is remembered here when the invite is redeemed, keyed by the box host.
/// Mirrors the webapp's `lib/knockIdentity.js`.
///
/// Holds only public keys and box names, so UserDefaults is fine.
public protocol InviteOwnerStoring: Sendable {
    /// Remember `ownerAidHex` as the owner of `serverDomain`. The latest redeem
    /// wins (a transferred box has a new owner).
    func remember(serverDomain: String, ownerAidHex: String)
    /// The owner AID (lowercase hex) remembered for the box `serverDomain`, or
    /// nil. An invite opened on an app's own host (`<app>.<box>`) still counts
    /// for the box.
    func ownerAidHex(forServer serverDomain: String) -> String?
}

public struct InviteOwnerStore: InviteOwnerStoring, @unchecked Sendable {
    static let storeKey = "flagship.inviteOwners.v1"

    private let defaults: UserDefaults
    private let now: () -> Double
    public init(
        defaults: UserDefaults = .standard,
        now: @escaping () -> Double = { Date().timeIntervalSince1970 }
    ) {
        self.defaults = defaults
        self.now = now
    }

    static func normalizeHost(_ host: String) -> String {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        return h
    }

    static func isAidHex(_ s: String) -> Bool {
        s.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }

    private func readAll() -> [String: [String: Any]] {
        defaults.dictionary(forKey: Self.storeKey) as? [String: [String: Any]] ?? [:]
    }

    public func remember(serverDomain: String, ownerAidHex: String) {
        let host = Self.normalizeHost(serverDomain)
        let aid = ownerAidHex.lowercased()
        guard !host.isEmpty, Self.isAidHex(aid) else { return }
        var all = readAll()
        all[host] = ["ownerAid": aid, "at": now()]
        defaults.set(all, forKey: Self.storeKey)
    }

    public func ownerAidHex(forServer serverDomain: String) -> String? {
        let host = Self.normalizeHost(serverDomain)
        guard !host.isEmpty else { return nil }
        let all = readAll()
        // An app-host record counts for its box; with several, the newest wins.
        let hit = all[host] ?? all
            .filter { $0.key.hasSuffix(".\(host)") }
            .max { ($0.value["at"] as? Double ?? 0) < ($1.value["at"] as? Double ?? 0) }?
            .value
        guard let aid = (hit?["ownerAid"] as? String)?.lowercased(), Self.isAidHex(aid) else { return nil }
        return aid
    }
}
