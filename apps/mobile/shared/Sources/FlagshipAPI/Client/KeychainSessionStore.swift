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

    public var sessionToken: String? {
        guard let data = readKeychain() else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func setPodBaseUrl(_ url: String?) {
        if let url { defaults.set(url, forKey: podBaseKey) }
        else { defaults.removeObject(forKey: podBaseKey) }
    }

    public func setSessionToken(_ token: String?) {
        if let token, let data = token.data(using: .utf8) {
            writeKeychain(data: data)
        } else {
            deleteKeychain()
        }
    }

    public func clear() {
        defaults.removeObject(forKey: podBaseKey)
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

    private func writeKeychain(data: Data) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
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
