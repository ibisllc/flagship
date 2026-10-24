import Foundation
import FlagshipAPI

/// The one store of the server keys (STK) this device trusts (docs/first-contact.md). A box makes its
/// own key at install; this device pins it the first time it blesses the server and checks everything
/// against the pin from then on: cert pins, status reports, LAN hints, secret and unlock requests, the
/// seal for the disk key, SWK, CGK and pairing deposits, the watch delegate. Nothing derives a server
/// key and `.com`'s word about one is never a trust input.
///
/// Public material, kept per device in UserDefaults (not synced). Changing a pin is only ever an
/// explicit re-trust (`forget`, called when the owner reinstalls from a new recipe or re-pairs).
public struct ServerKeyPins: @unchecked Sendable {
    static let key = "flagship.serverKeyPins.v1"
    /// The watch path's interim store, filled from `.com`'s directory: never a pin.
    static let legacyWatchKey = "flagship.watchBootKeys.pinnedStk"

    public enum Check: Equatable, Sendable {
        /// Nothing pinned yet: first sight.
        case unpinned
        case matches
        /// A different key is pinned: refuse, never replace silently.
        case changed
    }

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if defaults.object(forKey: Self.legacyWatchKey) != nil { defaults.removeObject(forKey: Self.legacyWatchKey) }
    }

    /// Pins kept only in memory (tests, previews).
    public static func volatile() -> ServerKeyPins {
        ServerKeyPins(defaults: UserDefaults(suiteName: "flagship.serverKeyPins.volatile.\(UUID().uuidString)") ?? .standard)
    }

    private var all: [String: String] {
        get { defaults.dictionary(forKey: Self.key) as? [String: String] ?? [:] }
        nonmutating set { defaults.set(newValue, forKey: Self.key) }
    }

    static func normalize(_ domain: String) -> String {
        var d = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while d.hasSuffix(".") { d.removeLast() }
        return d
    }

    /// The pinned key for a server, or nil when this device has not blessed it yet.
    public func pinnedStk(_ serverDomain: String) -> Data? {
        all[Self.normalize(serverDomain)].flatMap(HexUtil.decode).flatMap { $0.count == 32 ? $0 : nil }
    }

    public func pinnedStkHex(_ serverDomain: String) -> String? {
        pinnedStk(serverDomain).map(HexUtil.encode)
    }

    public func check(_ stk: Data, for serverDomain: String) -> Check {
        guard let pinned = pinnedStk(serverDomain) else { return .unpinned }
        return pinned == stk ? .matches : .changed
    }

    /// Pin the key at the first blessing. False when a different key is already pinned (it stays).
    @discardableResult
    public func pin(_ stk: Data, for serverDomain: String) -> Bool {
        guard stk.count == 32 else { return false }
        let d = Self.normalize(serverDomain)
        guard !d.isEmpty else { return false }
        if let pinned = pinnedStk(d) { return pinned == stk }
        var m = all
        m[d] = HexUtil.encode(stk)
        all = m
        return true
    }

    /// The explicit re-trust: the next blessing pins whatever key the server then has.
    public func forget(_ serverDomain: String) {
        var m = all
        m[Self.normalize(serverDomain)] = nil
        all = m
    }

    /// Every server with a pin.
    public func domains() -> [String] { all.keys.sorted() }

    /// A pinned server, or a name under its wildcard (`<app>.<server>.<user>`): the server it belongs to.
    public func pinnedServer(forHost host: String) -> String? {
        let h = Self.normalize(host)
        guard !h.isEmpty else { return nil }
        let keys = all.keys
        if keys.contains(h) { return h }
        return keys.first { h.hasSuffix(".\($0)") }
    }

    public func clear() { defaults.removeObject(forKey: Self.key) }
}
