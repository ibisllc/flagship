import Foundation
import Security

/// Keychain-backed SessionStore. The pod base URL lives in UserDefaults
/// (it's not a secret); the 32-byte hex session token lives in Keychain
/// with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` so it survives
/// app upgrades but never lands in iCloud Keychain backups or another
/// device.
///
/// Drop-in replacement for `SessionStore`. Inject this into
/// `LiveScreensClient` once a real pairing flow produces a token.
public actor KeychainSessionStore {
    private let defaults: UserDefaults
    private let service = "com.flagship.session"
    private let podBaseKey = "flagship.podBaseUrl"
    private let tokenAccount = "session-token"
    private let demoSessionKey = "flagship.demoSession.v1"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var podBaseUrl: String? {
        defaults.string(forKey: podBaseKey)
    }

    /// UserDefaults fallback key for the token. Only used when the Keychain is
    /// unavailable — notably an UNSIGNED app on the Simulator (UITest runs with
    /// `CODE_SIGNING_ALLOWED=NO`), where `SecItemAdd`/`SecItemCopyMatching` fail
    /// because there's no keychain-access-group entitlement, so a written token
    /// reads back nil. On a real (signed) device the Keychain write succeeds and
    /// this path is never taken — the token never lands in UserDefaults there.
    private let tokenFallbackKey = "flagship.sessionToken.fallback"

    public var sessionToken: String? {
        if let data = readKeychain(), let s = String(data: data, encoding: .utf8) {
            return s
        }
        // Keychain miss — fall back to the UserDefaults shadow (sim/UITest).
        return defaults.string(forKey: tokenFallbackKey)
    }

    public func setPodBaseUrl(_ url: String?) {
        if let url { defaults.set(url, forKey: podBaseKey) }
        else { defaults.removeObject(forKey: podBaseKey) }
    }

    public func setSessionToken(_ token: String?) {
        guard let token, let data = token.data(using: .utf8) else {
            deleteKeychain()
            defaults.removeObject(forKey: tokenFallbackKey)
            return
        }
        let ok = writeKeychain(data: data)
        if ok {
            // Keychain is authoritative — make sure no stale shadow lingers.
            defaults.removeObject(forKey: tokenFallbackKey)
        } else {
            // Keychain unavailable (unsigned sim/UITest) — shadow it so the
            // session token survives for the live client.
            defaults.set(token, forKey: tokenFallbackKey)
        }
    }

    public func clear() {
        defaults.removeObject(forKey: podBaseKey)
        defaults.removeObject(forKey: tokenFallbackKey)
        defaults.removeObject(forKey: podTokensFallbackKey)
        defaults.removeObject(forKey: demoSessionKey)
        deleteKeychain()
        deleteKeychain(account: podTokensAccount)
    }

    public var demoSession: DemoSessionRecord? {
        guard let data = defaults.data(forKey: demoSessionKey) else { return nil }
        return try? JSONDecoder().decode(DemoSessionRecord.self, from: data)
    }

    public func setDemoSession(_ session: DemoSessionRecord?) {
        guard let session else {
            defaults.removeObject(forKey: demoSessionKey)
            return
        }
        if let data = try? JSONEncoder().encode(session) {
            defaults.set(data, forKey: demoSessionKey)
        }
    }

    // MARK: - Per-pod token store (Fix B)
    //
    // The per-pod tokens are a SINGLE JSON `{ [podId]: token }` blob held in
    // Keychain (own account), with the same UserDefaults shadow fallback the
    // single token uses for the unsigned-sim/UITest case. Secrets never land in
    // UserDefaults on a real signed device.

    private let podTokensAccount = "session-pod-tokens"
    private let podTokensFallbackKey = "flagship.podTokens.fallback"

    private func readPodTokens() -> [String: String] {
        let data: Data?
        if let kc = readKeychain(account: podTokensAccount) {
            data = kc
        } else if let raw = defaults.data(forKey: podTokensFallbackKey) {
            data = raw
        } else {
            data = nil
        }
        guard let d = data, let map = try? JSONDecoder().decode([String: String].self, from: d) else { return [:] }
        return map
    }

    private func writePodTokens(_ map: [String: String]) {
        guard let data = try? JSONEncoder().encode(map) else { return }
        let ok = writeKeychain(account: podTokensAccount, data: data)
        if ok {
            defaults.removeObject(forKey: podTokensFallbackKey)
        } else {
            defaults.set(data, forKey: podTokensFallbackKey)
        }
    }

    public func sessionToken(forPodId podId: String) -> String? {
        guard !podId.isEmpty else { return nil }
        return readPodTokens()[podId.lowercased()]
    }

    public func setSessionToken(_ token: String?, forPodId podId: String) {
        guard !podId.isEmpty else { return }
        var map = readPodTokens()
        let key = podId.lowercased()
        if let token { map[key] = token } else { map.removeValue(forKey: key) }
        writePodTokens(map)
    }

    public func podTokenIds() -> [String] {
        Array(readPodTokens().keys)
    }

    public func migrateSingleTokenToPod(_ anchorPodId: String) {
        let key = anchorPodId.lowercased()
        guard !key.isEmpty else { return }
        var map = readPodTokens()
        guard map[key] == nil else { return }
        // The legacy single token lives in Keychain (or its sim shadow).
        guard let legacy = sessionToken, !legacy.isEmpty else { return }
        map[key] = legacy
        writePodTokens(map)
    }

    // MARK: - Keychain primitives

    private func readKeychain(account: String? = nil) -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account ?? tokenAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        return status == errSecSuccess ? (item as? Data) : nil
    }

    /// Returns true iff the token was actually written to the Keychain. A
    /// non-success status (e.g. `errSecMissingEntitlement` on an unsigned sim)
    /// signals the caller to use the UserDefaults shadow instead.
    @discardableResult
    private func writeKeychain(account: String? = nil, data: Data) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account ?? tokenAccount
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        return status == errSecSuccess
    }

    private func deleteKeychain(account: String? = nil) {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account ?? tokenAccount
        ]
        SecItemDelete(q as CFDictionary)
    }
}
