import Foundation
import Security

/// Persists the owner's Wi-Fi credentials across launches so they don't have
/// to retype them every burn. The SSID is non-secret (UserDefaults); the
/// password is a secret and lives in the macOS Keychain as a generic-password
/// item — never in plaintext UserDefaults.
///
/// This is the owner's own Wi-Fi on their own machine, so a Keychain item
/// scoped to this app is the right store.
enum WifiCredentialStore {
    private static let ssidKey = "assembler.wifi.ssid"
    private static let service = "com.flagshipserver.Burner.wifi"
    private static let account = "wifi-password"

    // MARK: - SSID (UserDefaults)

    static func loadSSID() -> String {
        UserDefaults.standard.string(forKey: ssidKey) ?? ""
    }

    static func saveSSID(_ ssid: String) {
        let trimmed = ssid.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            UserDefaults.standard.removeObject(forKey: ssidKey)
        } else {
            UserDefaults.standard.set(trimmed, forKey: ssidKey)
        }
    }

    // MARK: - Password (Keychain)

    static func loadPassword() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let pw = String(data: data, encoding: .utf8) else {
            return ""
        }
        return pw
    }

    static func savePassword(_ password: String) {
        // Empty password → clear the stored secret entirely.
        guard !password.isEmpty else {
            deletePassword()
            return
        }
        let data = Data(password.utf8)
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        // Try update first; if the item doesn't exist yet, add it.
        let attrs: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attrs as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var addQuery = baseQuery
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(addQuery as CFDictionary, nil)
        }
    }

    static func deletePassword() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
