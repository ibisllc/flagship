import Foundation
import FlagshipCore

/// Account read tokens in the Keychain, device-local and non-biometric
/// (docs/account-read-token.md). `Keystore.wipe()` removes them with the
/// account's keys.
public final class KeychainAccountReadTokenStore: AccountReadTokenStore, @unchecked Sendable {
    private let lock = NSLock()

    public init() {}

    public func load(username: String) -> StoredAccountReadToken? {
        lock.lock(); defer { lock.unlock() }
        return Keystore.loadAccountReadTokens()[username.lowercased()]
    }

    public func save(_ token: StoredAccountReadToken, username: String) {
        lock.lock(); defer { lock.unlock() }
        var map = Keystore.loadAccountReadTokens()
        map[username.lowercased()] = token
        Keystore.saveAccountReadTokens(map)
    }

    public func remove(username: String) {
        lock.lock(); defer { lock.unlock() }
        var map = Keystore.loadAccountReadTokens()
        guard map.removeValue(forKey: username.lowercased()) != nil else { return }
        Keystore.saveAccountReadTokens(map)
    }

    public func removeAll() {
        lock.lock(); defer { lock.unlock() }
        Keystore.saveAccountReadTokens([:])
    }
}
