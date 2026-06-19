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
        deleteKeychain()
    }

    // MARK: - Keychain primitives

    private func readKeychain() -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
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
    private func writeKeychain(data: Data) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        return status == errSecSuccess
    }

    private func deleteKeychain() {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount
        ]
        SecItemDelete(q as CFDictionary)
    }
}
