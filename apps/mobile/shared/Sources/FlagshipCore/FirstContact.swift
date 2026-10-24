import CryptoKit
import Foundation
import FlagshipAPI
import Security

/// The secrets this device keeps for a server it created until it pins the server's key
/// (docs/first-contact.md "What the clients do" 1 and 4): the recipe's one-time enrollment secret with
/// the AuthCode serial its proof covers, and the key Studio confirms the server code with. Kept in the
/// Keychain, this device only, never synced; deleted once the server is pinned.
public struct FirstContactSecret: Codable, Equatable, Sendable {
    public let enrollmentKeyHex: String
    public let authCodeSerial: String
    /// Sent to Studio beside the recipe (never inside it); nil when the recipe did not go to Studio.
    public var studioConfirmKeyHex: String?

    public init(enrollmentKeyHex: String, authCodeSerial: String, studioConfirmKeyHex: String? = nil) {
        self.enrollmentKeyHex = enrollmentKeyHex
        self.authCodeSerial = authCodeSerial
        self.studioConfirmKeyHex = studioConfirmKeyHex
    }

    public var enrollmentKey: Data? { HexUtil.decode(enrollmentKeyHex).flatMap { $0.count == 32 ? $0 : nil } }
    public var studioConfirmKey: Data? { studioConfirmKeyHex.flatMap(HexUtil.decode).flatMap { $0.count == 32 ? $0 : nil } }
}

public protocol FirstContactSecretStore: Sendable {
    func secret(for serverDomain: String) -> FirstContactSecret?
    func save(_ secret: FirstContactSecret, for serverDomain: String)
    func delete(for serverDomain: String)
}

/// Keychain store: `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, not synchronizable.
public struct KeychainFirstContactSecrets: FirstContactSecretStore {
    private let service = "com.flagship.first-contact"
    public init() {}

    #if DEBUG
    /// Gym seam: an unsigned simulator has no Keychain, so UI tests hold the secret here.
    nonisolated(unsafe) public static var gymOverride: InMemoryFirstContactSecrets?
    #endif

    private func query(_ domain: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: ServerKeyPins.normalize(domain),
         kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
    }

    public func secret(for serverDomain: String) -> FirstContactSecret? {
        #if DEBUG
        if let gym = Self.gymOverride { return gym.secret(for: serverDomain) }
        #endif
        var q = query(serverDomain)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(FirstContactSecret.self, from: data)
    }

    public func save(_ secret: FirstContactSecret, for serverDomain: String) {
        #if DEBUG
        if let gym = Self.gymOverride { gym.save(secret, for: serverDomain); return }
        #endif
        guard let data = try? JSONEncoder().encode(secret) else { return }
        SecItemDelete(query(serverDomain) as CFDictionary)
        var q = query(serverDomain)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    public func delete(for serverDomain: String) {
        #if DEBUG
        if let gym = Self.gymOverride { gym.delete(for: serverDomain); return }
        #endif
        SecItemDelete(query(serverDomain) as CFDictionary)
    }
}

public final class InMemoryFirstContactSecrets: FirstContactSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: FirstContactSecret] = [:]
    public init() {}
    public func secret(for serverDomain: String) -> FirstContactSecret? {
        lock.lock(); defer { lock.unlock() }
        return items[ServerKeyPins.normalize(serverDomain)]
    }
    public func save(_ secret: FirstContactSecret, for serverDomain: String) {
        lock.lock(); defer { lock.unlock() }
        items[ServerKeyPins.normalize(serverDomain)] = secret
    }
    public func delete(for serverDomain: String) {
        lock.lock(); defer { lock.unlock() }
        items[ServerKeyPins.normalize(serverDomain)] = nil
    }
}

/// How a box's request stands against this device's pin (docs/first-contact.md "What the clients do").
public enum FirstContactTrust: Equatable, Sendable {
    /// The request names the pinned key.
    case pinned
    /// No pin yet. `code` is computed here from the key the request names; `pinsOnApprove` is false only
    /// for a request without a proof from a server this device holds the secret for (a disk unlock before
    /// the box asks to serve): approving it opens the disk but pins nothing, and the box's entitlement
    /// request then carries the proof.
    case firstSight(code: String, pinsOnApprove: Bool)
    /// A different key is pinned. Refused.
    case keyChanged
    /// This device made the recipe and the proof is missing or wrong. Refused.
    case notFromRecipe

    public var isRefused: Bool { self == .keyChanged || self == .notFromRecipe }
}

public enum FirstContact {
    public static let studioSeenTag = "flagship/server-code-seen/v1"

    public static var notFromRecipeText: String {
        String(localized: "This server was not built from your recipe. Do not approve it.")
    }
    public static var keyChangedText: String {
        String(localized: "This server's key changed. If you did not rebuild it, do not approve anything for it.")
    }
    public static var confirmedByStudioText: String { String(localized: "Confirmed by Studio") }

    /// "482913" → "482 913".
    public static func pretty(_ code: String) -> String {
        guard code.count == 6 else { return code }
        return "\(code.prefix(3)) \(code.suffix(3))"
    }

    /// The sentence in the code box above Approve.
    public static func codeLine(_ code: String) -> String {
        let shown = pretty(code)
        return String(localized: "If your machine has a monitor, it is showing this code: \(shown)")
    }

    /// Weigh one request: `stkPubHex` is the key it names, verified by the caller under that key.
    public static func assess(
        serverDomain: String,
        stkPubHex: String,
        purpose: SecretPurpose,
        enrollmentProof: String?,
        pins: ServerKeyPins,
        secrets: FirstContactSecretStore
    ) -> FirstContactTrust {
        let hex = stkPubHex.lowercased()
        guard let stk = HexUtil.decode(hex), stk.count == 32, let code = Enrollment.serverCode(stkPubHex: hex) else {
            return .keyChanged
        }
        switch pins.check(stk, for: serverDomain) {
        case .matches: return .pinned
        case .changed: return .keyChanged
        case .unpinned: break
        }
        guard let held = secrets.secret(for: serverDomain), let key = held.enrollmentKey else {
            return .firstSight(code: code, pinsOnApprove: true)
        }
        if let proof = enrollmentProof, !proof.isEmpty {
            let ok = Enrollment.verify(secret: key, serverDomain: serverDomain, stkPubHex: hex,
                                       authCodeSerial: held.authCodeSerial, proofHex: proof)
            return ok ? .firstSight(code: code, pinsOnApprove: true) : .notFromRecipe
        }
        // The box sends its proof with the entitlement request, its first "is this your server?".
        return purpose == .entitlement ? .notFromRecipe : .firstSight(code: code, pinsOnApprove: false)
    }

    /// `serverSeen.macHex` on the order status: HMAC-SHA256(studioConfirmKey,
    /// `flagship/server-code-seen/v1|<domain lowercase>|<stkPubHex>`).
    public static func studioSeenMacHex(key: Data, serverDomain: String, stkPubHex: String) -> String? {
        let hex = stkPubHex.lowercased()
        guard key.count == 32, hex.count == 64, HexUtil.decode(hex) != nil, !serverDomain.contains("|") else { return nil }
        let msg = Data([studioSeenTag, ServerKeyPins.normalize(serverDomain), hex].joined(separator: "|").utf8)
        return HexUtil.encode(Data(HMAC<SHA256>.authenticationCode(for: msg, using: SymmetricKey(data: key))))
    }

    /// True when Studio saw exactly `expectedStkPubHex` on the server's console. A wrong MAC is ignored.
    public static func studioConfirms(
        key: Data, serverDomain: String, seenStkPubHex: String, macHex: String, expectedStkPubHex: String
    ) -> Bool {
        guard seenStkPubHex.lowercased() == expectedStkPubHex.lowercased(),
              let want = studioSeenMacHex(key: key, serverDomain: serverDomain, stkPubHex: seenStkPubHex)
        else { return false }
        let a = Array(want.utf8), b = Array(macHex.lowercased().utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }
}

/// What Studio told the phone about a server it hosts (`serverSeen` on the order status), kept until the
/// blessing reads it. The seam for "Confirmed by Studio": the order-status poll records it; the approval
/// asks `confirmed(serverDomain:stkPubHex:)`.
public final class StudioSeenStore: @unchecked Sendable {
    public static let shared = StudioSeenStore()
    private let lock = NSLock()
    private var seen: [String: [(stkPubHex: String, macHex: String)]] = [:]
    private let secrets: () -> FirstContactSecretStore

    public init(secrets: @escaping () -> FirstContactSecretStore = { KeychainFirstContactSecrets() }) {
        self.secrets = secrets
    }

    /// Keep one report (the newest four per server).
    public func record(serverDomain: String, stkPubHex: String, macHex: String) {
        let d = ServerKeyPins.normalize(serverDomain)
        lock.lock(); defer { lock.unlock() }
        var list = seen[d] ?? []
        list.append((stkPubHex.lowercased(), macHex.lowercased()))
        seen[d] = Array(list.suffix(4))
    }

    /// True when any of Studio's reports verifies under the kept key and names this exact key.
    public func confirmed(serverDomain: String, stkPubHex: String) -> Bool {
        lock.lock()
        let entries = seen[ServerKeyPins.normalize(serverDomain)] ?? []
        lock.unlock()
        guard !entries.isEmpty, let key = secrets().secret(for: serverDomain)?.studioConfirmKey else { return false }
        return entries.contains {
            FirstContact.studioConfirms(key: key, serverDomain: serverDomain, seenStkPubHex: $0.stkPubHex,
                                        macHex: $0.macHex, expectedStkPubHex: stkPubHex)
        }
    }

    public func forget(_ serverDomain: String) {
        lock.lock(); defer { lock.unlock() }
        seen[ServerKeyPins.normalize(serverDomain)] = nil
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        seen.removeAll()
    }

    /// The order-status poll's hook: replace what is kept with Studio's current list, if any.
    public func record(_ status: ProvisionStatus) {
        guard let list = status.serverSeen, !list.isEmpty, let domain = status.serverDomain, !domain.isEmpty else { return }
        forget(domain)
        for e in list.suffix(4) { record(serverDomain: domain, stkPubHex: e.stkPubHex, macHex: e.macHex) }
    }
}
