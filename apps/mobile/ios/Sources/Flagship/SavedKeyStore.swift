import Foundation
import Security
import FlagshipAPI

/// Device-local saved AI-key store.
///
/// Mirrors the webapp's `providers.js`: a multi-key list of
/// `{id, provider, label, apiKey, baseUrl?}` entries the owner can recall at
/// the build AI-key step or manage in Settings. The keys NEVER leave this
/// device except as an in-memory `LlmProviderCredential` handed to a build
/// request — at which point they travel phone → box over the box's own
/// pinned pipe, never through flagshipserver.com.
///
/// Persistence: one Generic-Password Keychain item holding the JSON list,
/// written `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` +
/// `kSecAttrSynchronizable=false` — device-local, NOT iCloud-synced (an AI
/// key is per-device convenience, not cloud-root identity, and we don't want
/// it replicated off this device). Test bundles on the simulator run without
/// the Keychain entitlement (SecItemAdd → -34018); like `Keystore`, we then
/// fall back to a process-local in-memory mirror so the round-trip is
/// exercisable in unit tests.
public struct SavedKeyStore {

    /// One saved key. `apiKey` is the only secret; everything else is safe to
    /// render (and the slug masks the key anyway).
    public struct Entry: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let provider: String
        public let label: String
        public let apiKey: String
        public let baseUrl: String?
        public init(id: String, provider: String, label: String, apiKey: String, baseUrl: String? = nil) {
            self.id = id
            self.provider = provider
            self.label = label
            self.apiKey = apiKey
            self.baseUrl = baseUrl
        }

        /// In-memory credential for a build request — the raw key, never
        /// persisted anywhere new by handing it over.
        public var credential: LlmProviderCredential {
            LlmProviderCredential(provider: provider, apiKey: apiKey, baseUrl: baseUrl)
        }
    }

    /// The whole stored list + which entry is the "active" one (pre-selected
    /// for one-tap Confirm at the AI-key step). `activeId == nil` ⇒ no
    /// preference yet (the first added entry becomes active).
    public struct State: Codable, Equatable, Sendable {
        public var entries: [Entry]
        public var activeId: String?
        public init(entries: [Entry] = [], activeId: String? = nil) {
            self.entries = entries
            self.activeId = activeId
        }
    }

    public enum StoreError: Error, LocalizedError {
        case invalidEntry
        case keychainFailed(OSStatus)
        public var errorDescription: String? {
            switch self {
            case .invalidEntry:        return "That key looks incomplete."
            case .keychainFailed(let s): return "Couldn't save the key (\(s))."
            }
        }
    }

    private static let account = "com.flagship.aikeys.v1"

    public init() {}

    // MARK: - Masking

    /// Mask an API key for display — first 4 + last 4 around bullets, never
    /// the middle. Short keys collapse entirely. The plaintext only ever
    /// lives in the typed input field or this store's Keychain item.
    public static func maskKey(_ k: String) -> String {
        if k.isEmpty { return "" }
        if k.count < 12 { return "••••" }
        return String(k.prefix(4)) + "••••" + String(k.suffix(4))
    }

    /// One-line recall slug: `provider · label · ••••last4`. Never the full
    /// key.
    public static func slug(for e: Entry) -> String {
        "\(e.provider) · \(e.label) · \(maskKey(e.apiKey))"
    }

    public func slug(for e: Entry) -> String { Self.slug(for: e) }

    // MARK: - CRUD

    /// The full state (entries + active pointer). Empty when nothing saved or
    /// the item is unreadable.
    public func load() -> State {
        guard let data = Self.keychainRead(account: Self.account) else { return State() }
        return (try? JSONDecoder().decode(State.self, from: data)) ?? State()
    }

    /// All saved entries, in insertion order.
    public func list() -> [Entry] { load().entries }

    /// The active entry (pre-selected for Confirm), if any.
    public func active() -> Entry? {
        let s = load()
        guard let id = s.activeId else { return s.entries.first }
        return s.entries.first { $0.id == id } ?? s.entries.first
    }

    /// Add a new key. Returns the created entry. The first entry added
    /// becomes active. A blank provider/label/key is rejected.
    @discardableResult
    public func add(provider: String, label: String, apiKey: String, baseUrl: String? = nil) throws -> Entry {
        let p = provider.trimmingCharacters(in: .whitespacesAndNewlines)
        let k = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let l = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = baseUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty, !k.isEmpty else { throw StoreError.invalidEntry }
        let entry = Entry(
            id: Self.newId(),
            provider: p,
            label: l.isEmpty ? p : l,
            apiKey: k,
            baseUrl: (b?.isEmpty == false) ? b : nil
        )
        var s = load()
        s.entries.append(entry)
        if s.activeId == nil { s.activeId = entry.id }
        try save(s)
        return entry
    }

    /// Delete a key by id. If it was active, the next remaining entry (if
    /// any) becomes active.
    public func remove(id: String) throws {
        var s = load()
        s.entries.removeAll { $0.id == id }
        if s.activeId == id { s.activeId = s.entries.first?.id }
        try save(s)
    }

    /// Make `id` the active (pre-selected) entry.
    public func setActive(id: String) throws {
        var s = load()
        guard s.entries.contains(where: { $0.id == id }) else { return }
        s.activeId = id
        try save(s)
    }

    /// Wipe every saved key (used by a tier-2/3 device reset so no key is
    /// left at rest).
    public func clear() {
        Self.keychainDelete(account: Self.account)
    }

    private func save(_ s: State) throws {
        let data = try JSONEncoder().encode(s)
        try Self.keychainWrite(account: Self.account, data: data)
    }

    private static func newId() -> String {
        var b = [UInt8](repeating: 0, count: 8)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        return b.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Keychain (device-local, non-syncing)

    private static func keychainWrite(account: String, data: Data) throws {
        // Clear any prior item (synced or not) under this account first, so a
        // stale class can't shadow the new write.
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(baseQuery as CFDictionary)

        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            // Device-local convenience key — never iCloud-synced.
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecSuccess { return }
        // No Keychain entitlement (simulator test bundle) → in-memory mirror.
        if status == errSecMissingEntitlement {
            InMemoryKeyStore.shared.write(account: account, data: data)
            return
        }
        throw StoreError.keychainFailed(status)
    }

    private static func keychainRead(account: String) -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data { return data }
        return InMemoryKeyStore.shared.read(account: account)
    }

    private static func keychainDelete(account: String) {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(q as CFDictionary)
        InMemoryKeyStore.shared.remove(account: account)
    }
}

/// Process-local fallback for test bundles without the Keychain entitlement
/// (mirrors `Keystore`'s InMemoryStore — kept separate so the two never
/// share account-string collisions).
final class InMemoryKeyStore: @unchecked Sendable {
    static let shared = InMemoryKeyStore()
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    func read(account: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return items[account]
    }
    func write(account: String, data: Data) {
        lock.lock(); defer { lock.unlock() }
        items[account] = data
    }
    func remove(account: String) {
        lock.lock(); defer { lock.unlock() }
        items.removeValue(forKey: account)
    }
}
