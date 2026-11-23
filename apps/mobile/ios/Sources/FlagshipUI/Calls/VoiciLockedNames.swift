import Foundation
import Security
import FlagshipCore

/// Names on a locked phone (docs/voici-locked-caller-names.md, owner-agreed 2026-11-22): a small table outside the app
/// lock, readable after the first unlock since boot (like Contacts), so a locked phone can show the nickname of a
/// visitor the owner has really had calls with, and the page name of a ring-back. Opt-in ("Show names while locked"),
/// rebuilt whole from the unlocked account, never synced, erased when the setting goes off or the account leaves.
///
/// What it holds at most: 50 nicknames, keyed by a hash of the caller's pseudonym (`VoiciRings.lockedNameKey`), and 50
/// pages this account may be rung back from, keyed by their ring tag key. Never logged, never sent anywhere, never read
/// by a model.
public struct VoiciLockedNamesTable: Codable, Equatable, Sendable {
    public struct Name: Codable, Equatable, Sendable {
        public var n: String
        public var last: Int64
    }

    public struct Ring: Codable, Equatable, Sendable {
        public var u: String
        public var p: String
        public var last: Int64
    }

    public var v = 1
    public var account: String
    public var builtAt: Int64
    public var names: [String: Name]
    public var rings: [String: Ring]
}

public enum VoiciLockedNames {
    public static let maxEntries = 50
    /// "Had calls with" and the ring-back channel's life: 90 days.
    public static let windowMs: Int64 = 90 * 86_400_000

    /// A page this account may be rung back from, as this device knows it: its own calls to it (each call to a page
    /// that takes call-backs attached the channel) and ring-backs it opened.
    public struct RingPage: Equatable, Sendable {
        public var username: String
        public var pageId: String
        public var last: Int64
        public init(username: String, pageId: String, last: Int64) { self.username = username; self.pageId = pageId; self.last = last }
    }

    static func isPseudonym(_ s: String) -> Bool { CanonicalJson.isLowerHex(s, bytes: 32) }

    /// The whole table from what the unlocked account holds. `includeNames` only while "Answer calls while Flagship is
    /// locked" is on for a page that takes calls; ring-back pages whenever the setting is on (`messagesSecret` derives
    /// their tag keys; without it there are none).
    public static func build(account: String, now: Int64, includeNames: Bool, nicknames: [String: String], blocked: Set<String>,
                             forgotten: [String: MessagesState.Forgotten], records: [VoiciCallRecord], missed: [VoiciMissedCallRow],
                             ringPages: [RingPage], stoppedAt: [String: Int64], messagesSecret: [UInt8]?) -> VoiciLockedNamesTable {
        let since = now - windowMs
        var names: [String: VoiciLockedNamesTable.Name] = [:]
        if includeNames {
            let goneConvs = Set(forgotten.keys)
            let gonePubs = Set(forgotten.values.compactMap(\.pseudonymPub))
            var last: [String: Int64] = [:]
            func saw(_ conv: String, _ pub: String, _ at: Int64) {
                guard at >= since, at <= now + 60_000, isPseudonym(pub), !goneConvs.contains(conv), !gonePubs.contains(pub), !blocked.contains(pub) else { return }
                last[pub] = max(last[pub] ?? 0, at)
            }
            for r in records where r.outcome != .failed {
                if case .visitor(let conv, let pub) = r.peer { saw(conv, pub, r.at) }
            }
            for m in missed { saw(m.conv, m.pseudonymPub, m.ringingAt) }
            let picked = last.compactMap { pub, at -> (String, String, Int64)? in
                guard let n = nicknames[pub]?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty else { return nil }
                return (pub, n, at)
            }
            for (pub, n, at) in newest(picked, at: \.2) { names[VoiciRings.lockedNameKey(pseudonymPub: pub)] = .init(n: n, last: at) }
        }
        var rings: [String: VoiciLockedNamesTable.Ring] = [:]
        if let messagesSecret {
            var byPage: [String: RingPage] = [:]
            for p in ringPages where p.last >= since && p.last <= now + 60_000 && p.last > (stoppedAt[p.pageId] ?? -1) && VoiciCallTarget.username(from: p.username) == p.username {
                if (byPage[p.pageId]?.last ?? -1) < p.last { byPage[p.pageId] = p }
            }
            for p in newest(Array(byPage.values), at: \.last) {
                guard let k = try? VoiciRings.deriveRingTagKey(messagesSecret: messagesSecret, pageId: p.pageId) else { continue }
                rings[CanonicalJson.hex(k)] = .init(u: p.username, p: p.pageId, last: p.last)
            }
        }
        return VoiciLockedNamesTable(account: account.lowercased(), builtAt: now, names: names, rings: rings)
    }

    private static func newest<T>(_ xs: [T], at: KeyPath<T, Int64>) -> [T] {
        Array(xs.sorted { $0[keyPath: at] > $1[keyPath: at] }.prefix(maxEntries))
    }

    /// The nickname for a ringing caller's pseudonym, while it is still within the window.
    public static func name(for pseudonymPub: String, in table: VoiciLockedNamesTable?, account: String, now: Int64) -> String? {
        guard let table, table.account == account.lowercased(), isPseudonym(pseudonymPub),
              let e = table.names[VoiciRings.lockedNameKey(pseudonymPub: pseudonymPub)], now - e.last <= windowMs, !e.n.isEmpty else { return nil }
        return e.n
    }

    /// The page a ring-back push names by its tag: every entry is tried (constant time per tag), so the time taken
    /// doesn't say which one matched.
    public static func ringPage(for push: VoiciRingPush, in table: VoiciLockedNamesTable?, now: Int64) -> (username: String, pageId: String)? {
        guard let table, let tag = push.tag else { return nil }
        var hit: VoiciLockedNamesTable.Ring?
        for (keyHex, ring) in table.rings {
            guard CanonicalJson.isLowerHex(keyHex, bytes: 32) else { continue }
            if VoiciRings.ringTagMatches(tagKey: (try? CanonicalJson.hexToBytes(keyHex)) ?? [], ringId: push.ringId, tag: tag), now - ring.last <= windowMs { hit = ring }
        }
        return hit.map { ($0.u, $0.p) }
    }
}

/// Where the table lives: one Keychain item per account, `AfterFirstUnlockThisDeviceOnly` (readable while ringing after
/// the first unlock since boot, never in a backup or on a restored phone), no user presence, no access group (the widget
/// and watch extensions don't read it).
public enum VoiciLockedNamesStore {
    static let service = "com.flagship.voici.locked-names"

    /// The Keychain the store writes to: the system one, or memory in tests.
    nonisolated(unsafe) static var keychain: LockedNamesKeychain = SystemLockedNamesKeychain()

    /// The attributes of the item `save` adds (pinned by a test).
    static func addQuery(username: String, data: Data) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: username.lowercased(),
         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
         kSecValueData as String: data]
    }

    public static func save(_ t: VoiciLockedNamesTable) throws {
        let data = try JSONEncoder().encode(t)
        keychain.delete(service: service, account: t.account)
        let st = keychain.add(addQuery(username: t.account, data: data))
        guard st == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(st)) }
    }

    public static func load(username: String) -> VoiciLockedNamesTable? {
        guard let data = keychain.read(service: service, account: username.lowercased()),
              let t = try? JSONDecoder().decode(VoiciLockedNamesTable.self, from: data), t.v == 1, t.account == username.lowercased() else { return nil }
        return t
    }

    public static func delete(username: String) { keychain.delete(service: service, account: username.lowercased()) }

    /// Every account's table (a full reset of this device).
    public static func deleteAll() { keychain.delete(service: service, account: nil) }
}

protocol LockedNamesKeychain: Sendable {
    func add(_ query: [String: Any]) -> OSStatus
    func read(service: String, account: String) -> Data?
    func delete(service: String, account: String?)
}

struct SystemLockedNamesKeychain: LockedNamesKeychain {
    func add(_ query: [String: Any]) -> OSStatus { SecItemAdd(query as CFDictionary, nil) }

    func read(service: String, account: String) -> Data? {
        var out: CFTypeRef?
        let st = SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                      kSecAttrAccount as String: account, kSecReturnData as String: true] as CFDictionary, &out)
        return st == errSecSuccess ? out as? Data : nil
    }

    func delete(service: String, account: String?) {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let account { q[kSecAttrAccount as String] = account }
        SecItemDelete(q as CFDictionary)
    }
}

/// The per-device choices: "Show names while locked" per account, whether the one-time sheet was shown, and when this
/// device last stopped call-backs from a page (a call-back stopped after the last call to that page drops its entry).
public enum VoiciLockedNamesSettings {
    static func onKey(_ u: String) -> String { "flagship.voici.lockedNames.on.\(u.lowercased())" }
    static func sheetKey(_ u: String) -> String { "flagship.voici.lockedNames.sheetShown.\(u.lowercased())" }
    static func stopsKey(_ u: String) -> String { "flagship.voici.lockedNames.stops.\(u.lowercased())" }

    public static func isOn(_ u: String, defaults: UserDefaults = .standard) -> Bool { !u.isEmpty && defaults.bool(forKey: onKey(u)) }
    public static func setOn(_ u: String, _ on: Bool, defaults: UserDefaults = .standard) {
        guard !u.isEmpty else { return }
        if on { defaults.set(true, forKey: onKey(u)) } else { defaults.removeObject(forKey: onKey(u)) }
    }

    public static func sheetShown(_ u: String, defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: sheetKey(u)) }
    public static func markSheetShown(_ u: String, defaults: UserDefaults = .standard) { if !u.isEmpty { defaults.set(true, forKey: sheetKey(u)) } }

    public static func stops(_ u: String, defaults: UserDefaults = .standard) -> [String: Int64] {
        (defaults.dictionary(forKey: stopsKey(u)) as? [String: Int64]) ?? [:]
    }
    public static func noteStopped(_ u: String, pageId: String, at: Int64, defaults: UserDefaults = .standard) {
        guard !u.isEmpty else { return }
        var s = stops(u, defaults: defaults).filter { at - $0.value < VoiciLockedNames.windowMs }
        s[pageId] = at
        defaults.set(s, forKey: stopsKey(u))
    }

    /// The account left this device: its choices go with it.
    public static func forget(username: String?, allProfiles: Bool, defaults: UserDefaults = .standard) {
        if allProfiles {
            for k in defaults.dictionaryRepresentation().keys where k.hasPrefix("flagship.voici.lockedNames.") { defaults.removeObject(forKey: k) }
        } else if let u = username, !u.isEmpty {
            for k in [onKey(u), sheetKey(u), stopsKey(u)] { defaults.removeObject(forKey: k) }
        }
    }
}
