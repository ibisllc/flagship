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

    /// One pin: the STK, plus what that STK vouched for since (architecture v2, `BoxKeyPins`): the
    /// ML-DSA-65 key its `box-stk` binding names and the boot-only key its boot-key binding names.
    public struct Record: Equatable, Sendable {
        public let stkHex: String
        public var mldsa: String?
        public var mldsaIssuedAt: Int64?
        public var boot: String?
        public var bootIssuedAt: Int64?

        public var stk: Data? { HexUtil.decode(stkHex).flatMap { $0.count == 32 ? $0 : nil } }

        init?(_ value: Any?) {
            let fields = value as? [String: Any]
            guard let hex = ((value as? String) ?? (fields?["stk"] as? String))?.lowercased(),
                  let raw = HexUtil.decode(hex), raw.count == 32
            else { return nil }
            stkHex = hex
            mldsa = fields?["mldsa"] as? String
            mldsaIssuedAt = (fields?["mldsaIssuedAt"] as? NSNumber)?.int64Value
            boot = fields?["boot"] as? String
            bootIssuedAt = (fields?["bootIssuedAt"] as? NSNumber)?.int64Value
        }

        /// A bare hex string while the STK has vouched for nothing, as pins were kept before.
        var stored: Any {
            guard mldsa != nil || boot != nil else { return stkHex }
            var d: [String: Any] = ["stk": stkHex]
            if let mldsa { d["mldsa"] = mldsa }
            if let mldsaIssuedAt { d["mldsaIssuedAt"] = NSNumber(value: mldsaIssuedAt) }
            if let boot { d["boot"] = boot }
            if let bootIssuedAt { d["bootIssuedAt"] = NSNumber(value: bootIssuedAt) }
            return d
        }
    }

    private var all: [String: Any] {
        get { defaults.dictionary(forKey: Self.key) ?? [:] }
        nonmutating set { defaults.set(newValue, forKey: Self.key) }
    }

    static func normalize(_ domain: String) -> String {
        var d = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while d.hasSuffix(".") { d.removeLast() }
        return d
    }

    /// The pinned key for a server, or nil when this device has not blessed it yet.
    public func pinnedStk(_ serverDomain: String) -> Data? {
        record(serverDomain)?.stk
    }

    /// The whole pin for a server, or nil when this device has not blessed it yet.
    public func record(_ serverDomain: String) -> Record? {
        Record(all[Self.normalize(serverDomain)])
    }

    /// Add what the pinned STK vouched for to its pin, only while `stkHex` is still the pin (a
    /// re-trust in between drops the update). False when it was dropped.
    @discardableResult
    public func update(_ serverDomain: String, stkHex: String, _ change: (inout Record) -> Void) -> Bool {
        let d = Self.normalize(serverDomain)
        guard var r = record(d), r.stkHex == stkHex.lowercased() else { return false }
        change(&r)
        var m = all
        m[d] = r.stored
        all = m
        return true
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
