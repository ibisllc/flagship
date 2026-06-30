import Foundation
import Security

/// Durable, encrypted-at-rest record of an in-flight phone↔burner pairing
/// session, so the session SURVIVES the phone briefly locking + the app being
/// suspended (and, in the worst case, the app being terminated). On the next
/// foreground/launch the `BurnerPairViewModel` reconnects to the SAME relay
/// `sid` reusing the SAME ephemeral X25519 keypair — the Mac burner holds the
/// session and auto-resumes on an identical `phone-hello` pubkey (no second
/// SAS). See `docs/recipe-delivery-and-remote-install.md` (Path B).
///
/// This is ephemeral pairing material plus (potentially) the unsealed recipe
/// wire bytes, so it lives in Keychain (`…ThisDeviceOnly`, never iCloud) and is
/// WIPED on explicit disconnect / `expired` / a delivered+done session.
public struct PersistedBurnerPairing: Codable, Sendable, Equatable {
    /// The relay session id (`/burner-pipe/<sid>`).
    public var sid: String
    /// The phone's ephemeral X25519 PRIVATE key, raw — reused verbatim on
    /// resume so the burner recognises the same peer and skips the SAS.
    public var phoneSkRaw: Data
    /// The burner's public key (nil when typed-code and not yet learned).
    public var burnerPkRaw: Data?
    /// The SAS was confirmed → on resume we skip the match screen.
    public var confirmed: Bool
    /// The recipe was delivered → on resume we don't re-deliver.
    public var recipeDelivered: Bool
    /// The verified server domain, for display on resume.
    public var serverDomain: String
    /// The unsealed recipe wire bytes, so the recipe can be re-sealed +
    /// re-delivered after a resume without re-minting (which would mint a new
    /// auth-code/serial). nil until minted.
    public var recipeWire: Data?
    /// The minted auth-code serial (pending-pod bookkeeping). nil until minted.
    public var serial: String?
    /// Session deadline, ms since epoch (~1h), from the relay `accepted` frame.
    public var expiresAtMs: Int64

    public init(
        sid: String,
        phoneSkRaw: Data,
        burnerPkRaw: Data?,
        confirmed: Bool,
        recipeDelivered: Bool,
        serverDomain: String,
        recipeWire: Data?,
        serial: String?,
        expiresAtMs: Int64
    ) {
        self.sid = sid
        self.phoneSkRaw = phoneSkRaw
        self.burnerPkRaw = burnerPkRaw
        self.confirmed = confirmed
        self.recipeDelivered = recipeDelivered
        self.serverDomain = serverDomain
        self.recipeWire = recipeWire
        self.serial = serial
        self.expiresAtMs = expiresAtMs
    }
}

/// Synchronous load/save/clear of the single active pairing record. Synchronous
/// so the `@MainActor` VM can read it inline on resume; Keychain ops are
/// blocking anyway.
public protocol BurnerPairingStore: Sendable {
    func load() -> PersistedBurnerPairing?
    func save(_ rec: PersistedBurnerPairing)
    func clear()
}

/// Keychain-backed store (mirrors `KeychainSessionStore`'s primitives). The
/// JSON record lives in a generic-password item with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (survives app upgrades,
/// never iCloud, never another device). On an UNSIGNED simulator (UITest with
/// `CODE_SIGNING_ALLOWED=NO`) the Keychain write fails, so it shadows into
/// UserDefaults — never a secret on a real signed device.
public final class KeychainBurnerPairingStore: BurnerPairingStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let service = "com.flagship.burner-pairing"
    private let account = "active-session"
    private let fallbackKey = "flagship.burnerPairing.fallback"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> PersistedBurnerPairing? {
        let data: Data?
        if let kc = readKeychain() {
            data = kc
        } else {
            data = defaults.data(forKey: fallbackKey)
        }
        guard let d = data,
              let rec = try? JSONDecoder().decode(PersistedBurnerPairing.self, from: d) else { return nil }
        return rec
    }

    public func save(_ rec: PersistedBurnerPairing) {
        guard let data = try? JSONEncoder().encode(rec) else { return }
        if writeKeychain(data: data) {
            defaults.removeObject(forKey: fallbackKey)
        } else {
            defaults.set(data, forKey: fallbackKey)
        }
    }

    public func clear() {
        deleteKeychain()
        defaults.removeObject(forKey: fallbackKey)
    }

    // MARK: - Keychain primitives

    private func readKeychain() -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        return status == errSecSuccess ? (item as? Data) : nil
    }

    @discardableResult
    private func writeKeychain(data: Data) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    private func deleteKeychain() {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(q as CFDictionary)
    }
}

/// In-memory store for tests/preview — no Keychain, no persistence across
/// process restarts.
public final class InMemoryBurnerPairingStore: BurnerPairingStore, @unchecked Sendable {
    private let lock = NSLock()
    private var rec: PersistedBurnerPairing?

    public init(_ initial: PersistedBurnerPairing? = nil) { self.rec = initial }

    public func load() -> PersistedBurnerPairing? {
        lock.lock(); defer { lock.unlock() }
        return rec
    }
    public func save(_ rec: PersistedBurnerPairing) {
        lock.lock(); defer { lock.unlock() }
        self.rec = rec
    }
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        rec = nil
    }
}
