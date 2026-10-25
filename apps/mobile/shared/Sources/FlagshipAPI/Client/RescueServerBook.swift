import Foundation

/// Where this device last saw each of its servers on a local network (docs/data-sovereignty.md
/// 4.9, "rescue-servers"): written whenever a box proves itself on the LAN (a LAN-direct hint, a
/// rescue hello), read by Offline control before anything else so a box can be tried with no `.com`
/// and no Bonjour. Names and addresses only, never trusted: the box's signed hello decides. Kept per
/// device, not synced, and kept when `.com` says the account is gone.
public struct RescueServerBook: @unchecked Sendable {
    static let key = "flagship.rescueServers.v1"
    static let maxAddresses = 8

    public struct Entry: Codable, Equatable, Sendable {
        public let domain: String
        /// `192.168.1.20:443`, newest first.
        public let lan: [String]
        public let seenAt: Int64
    }

    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public static let shared = RescueServerBook()

    /// Kept only in memory (tests, previews, the gym).
    public static func volatile() -> RescueServerBook {
        RescueServerBook(defaults: UserDefaults(suiteName: "flagship.rescueServers.volatile.\(UUID().uuidString)") ?? .standard)
    }

    private var all: [String: Entry] {
        get {
            guard let d = defaults.data(forKey: Self.key), let m = try? JSONDecoder().decode([String: Entry].self, from: d) else { return [:] }
            return m
        }
        nonmutating set { defaults.set(try? JSONEncoder().encode(newValue), forKey: Self.key) }
    }

    public func entries() -> [Entry] { all.values.sorted { $0.domain < $1.domain } }
    public func entry(_ domain: String) -> Entry? { all[domain.lowercased()] }

    /// Remember that `domain` answered at `address` (`host:port`) just now.
    public func saw(_ domain: String, at address: String, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) {
        let d = domain.lowercased()
        guard !d.isEmpty, address.count <= 64 else { return }
        var m = all
        let old = m[d]?.lan ?? []
        m[d] = Entry(domain: d, lan: Array(([address] + old.filter { $0 != address }).prefix(Self.maxAddresses)), seenAt: now)
        all = m
    }

    /// Remember a server by name with no address yet (a restored key file, a typed name).
    public func remember(_ domain: String, lan: [String] = []) {
        let d = domain.lowercased()
        guard !d.isEmpty else { return }
        var m = all
        let merged = (m[d]?.lan ?? []) + lan.filter { !(m[d]?.lan ?? []).contains($0) }
        m[d] = Entry(domain: d, lan: Array(merged.prefix(Self.maxAddresses)), seenAt: m[d]?.seenAt ?? 0)
        all = m
    }

    public func forget(_ domain: String) {
        var m = all
        m.removeValue(forKey: domain.lowercased())
        all = m
    }

    public func clear() { defaults.removeObject(forKey: Self.key) }
}
