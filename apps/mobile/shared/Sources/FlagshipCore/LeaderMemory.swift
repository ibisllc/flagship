import Foundation

/// The owner's "Make leader" choice, remembered on this device per account so
/// a cold launch doesn't fall back to the oldest server
/// (docs/app-placement.md §1). The webapp keeps the same choice in
/// localStorage. A pod id is derived from the server's fqdn, so it is stable
/// across launches.
public protocol LeaderMemory: AnyObject {
    func leaderPodId(forAccount account: String) -> String?
    func setLeaderPodId(_ podId: String?, forAccount account: String)
}

public final class UserDefaultsLeaderMemory: LeaderMemory, @unchecked Sendable {
    private let defaults: UserDefaults
    private static let prefix = "flagship.leaderPodId.v1."

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ account: String) -> String {
        prefix + account.lowercased()
    }

    public func leaderPodId(forAccount account: String) -> String? {
        guard !account.isEmpty else { return nil }
        return defaults.string(forKey: Self.key(account))
    }

    public func setLeaderPodId(_ podId: String?, forAccount account: String) {
        guard !account.isEmpty else { return }
        if let podId, !podId.isEmpty {
            defaults.set(podId, forKey: Self.key(account))
        } else {
            defaults.removeObject(forKey: Self.key(account))
        }
    }
}
