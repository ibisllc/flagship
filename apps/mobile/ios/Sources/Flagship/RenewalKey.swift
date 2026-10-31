import Foundation
import CryptoKit
import Security
import FlagshipCore
import FlagshipAPI

/// This admin device's serving renewal key (docs/architecture-v2/serving-wiring.md section 4): an
/// ECDSA P-256 key in the Secure Enclave that signs the serving lease each time the app opens, with
/// no prompt. The admin root delegates it once (`renewal-key-delegation/v1`); a lease it signs is
/// worth no more than a lease the admin root signs, and removing the device revokes it.
///
/// - Secure Enclave key (CryptoKit `SecureEnclave.P256.Signing`), access control
///   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` + `.privateKeyUsage` only (no user presence),
///   so it signs in the background. The Keychain keeps only the enclave's opaque handle, which no
///   other device can use. The Simulator has no enclave: a software P-256 key in the same item.
/// - Never synced, never in a backup that restores to another device.
/// - A fresh install starts without one (owner rule): the Keychain survives an app delete, so the
///   first launch deletes any renewal key a previous install left (`discardIfFreshInstall`).
public enum RenewalKey {
    /// Every renewal-key item carries this service, so one delete clears every profile's.
    static let service = "com.flagship.renewal-key"
    private static let installMarker = "flagship.renewal-key.install"
    private static let delegatedPrefix = "flagship.renewal-key.delegated."

    public struct Signer: Sendable {
        /// SEC1 compressed public key, 66 lowercase hex.
        public let publicKeyHex: String
        /// ECDSA P-256 over SHA-256 of `message`, compact `r‖s` (not yet low-S normalised).
        public let sign: @Sendable (Data) throws -> Data
        public init(publicKeyHex: String, sign: @escaping @Sendable (Data) throws -> Data) {
            self.publicKeyHex = publicKeyHex
            self.sign = sign
        }
    }

    public enum Failure: Error, Equatable {
        case keychain(OSStatus)
        case unusable
    }

    // MARK: lifecycle

    /// Run once at launch, before anything reads the key. UserDefaults go with the app on delete,
    /// the Keychain doesn't: no marker means this is a new install, so any renewal key found is a
    /// previous install's and is deleted (its delegation dies with the old device on `.com`).
    public static func discardIfFreshInstall(defaults: UserDefaults = .standard) {
        guard defaults.string(forKey: installMarker) == nil else { return }
        deleteAll()
        for k in defaults.dictionaryRepresentation().keys where k.hasPrefix(delegatedPrefix) { defaults.removeObject(forKey: k) }
        defaults.set(UUID().uuidString, forKey: installMarker)
    }

    /// The key for the active profile, without creating one.
    public static func load(profile: String = Keystore.activeProfileId) -> Signer? {
        guard let blob = read(account: account(profile)) else { return nil }
        return try? signer(from: blob)
    }

    /// The key for the active profile, made now if there is none.
    public static func loadOrCreate(profile: String = Keystore.activeProfileId) throws -> Signer {
        if let s = load(profile: profile) { return s }
        let blob = try makeKeyBlob()
        try write(account: account(profile), data: blob)
        guard let s = try? signer(from: blob) else { throw Failure.unusable }
        return s
    }

    /// Sign-out / wipe of one profile.
    public static func delete(profile: String = Keystore.activeProfileId, defaults: UserDefaults = .standard) {
        remove(account: account(profile))
        for k in defaults.dictionaryRepresentation().keys where k.hasPrefix(delegatedPrefix) { defaults.removeObject(forKey: k) }
    }

    /// Every profile's renewal key.
    public static func deleteAll() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ] as CFDictionary)
        memory.withLock { $0.removeAll() }
    }

    // MARK: delegation bookkeeping (non-secret)

    /// The delegation `.com` accepted for this key on `account`, so it is signed once.
    public static func delegation(account: String, defaults: UserDefaults = .standard) -> SignedServingRecord<RenewalKeyDelegation>? {
        guard let data = defaults.data(forKey: delegatedPrefix + account.lowercased()),
              let d = try? JSONDecoder().decode(SignedServingRecord<RenewalKeyDelegation>.self, from: data),
              d.record.renewalPub == load()?.publicKeyHex else { return nil }
        return d
    }

    public static func recordDelegation(_ d: SignedServingRecord<RenewalKeyDelegation>, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(d) else { return }
        defaults.set(data, forKey: delegatedPrefix + d.record.account.lowercased())
    }

    // MARK: key material

    private static func account(_ profile: String) -> String { "renewal-key." + profile }

    private static func makeKeyBlob() throws -> Data {
        #if targetEnvironment(simulator)
        return Data([0x00]) + P256.Signing.PrivateKey().rawRepresentation
        #else
        guard SecureEnclave.isAvailable else { throw Failure.unusable }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error
        ) else { throw Failure.unusable }
        let key = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: access)
        return Data([0x01]) + key.dataRepresentation
        #endif
    }

    /// The first byte says what follows: 0x01 a Secure Enclave handle, 0x00 a software key (Simulator only).
    private static func signer(from blob: Data) throws -> Signer {
        guard let kind = blob.first else { throw Failure.unusable }
        let body = blob.dropFirst()
        switch kind {
        case 0x01:
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: Data(body))
            return Signer(publicKeyHex: ServingAuthority.compressedHex(key.publicKey)) { msg in
                try key.signature(for: msg).rawRepresentation
            }
        case 0x00:
            #if targetEnvironment(simulator)
            let key = try P256.Signing.PrivateKey(rawRepresentation: Data(body))
            return Signer(publicKeyHex: ServingAuthority.compressedHex(key.publicKey)) { msg in
                try key.signature(for: msg).rawRepresentation
            }
            #else
            throw Failure.unusable
            #endif
        default:
            throw Failure.unusable
        }
    }

    // MARK: Keychain

    /// Test bundles without the Keychain entitlement keep the item in memory (as Keystore does).
    private static let memory = LockedDictionary()

    private static func write(account: String, data: Data) throws {
        remove(account: account)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecSuccess { return }
        if status == errSecMissingEntitlement {
            memory.withLock { $0[account] = data }
            return
        }
        throw Failure.keychain(status)
    }

    private static func read(account: String) -> Data? {
        var result: AnyObject?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ] as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data { return data }
        return memory.withLock { $0[account] }
    }

    private static func remove(account: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ] as CFDictionary)
        memory.withLock { $0[account] = nil }
    }
}

final class LockedDictionary: @unchecked Sendable {
    private let lock = NSLock()
    private var value: [String: Data] = [:]
    func withLock<T>(_ body: (inout [String: Data]) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}
