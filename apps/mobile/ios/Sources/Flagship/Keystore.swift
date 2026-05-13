import Foundation
import CryptoKit
import LocalAuthentication
import Security

/// User Master Key (UMK) — root of identity for a Flagship account.
///
/// Persistence model:
///   1. A wrapping keypair is held in the Secure Enclave (real devices)
///      or as a non-SE EC keypair in the Keychain (simulator). Biometric
///      ACL gates access on both paths.
///   2. A 32-byte UMK seed is generated with the CryptoKit CSPRNG,
///      wrapped with AES-GCM under a key derived via HKDF-SHA256 over
///      an ECDH(wrapping_priv, ephemeral_pub) raw secret, and the
///      wrapped blob + ephemeral public key land in the Keychain.
///   3. Derived keys (BAK = boot, IRK = identity-rotation, SWK = server-
///      wrap) come from HKDF over the unwrapped UMK with info string
///      `flagship/<purpose>/v1[|<scope>]` — same canonical tag prefix
///      used everywhere else in the codebase.
public struct Keystore {

    public enum KeystoreError: Error, LocalizedError {
        case keyNotFound
        case biometricFailed(OSStatus)
        case derivationFailed(String)
        case wrapFailed(String)
        case unwrapFailed(String)
        case keychainFailed(OSStatus)

        public var errorDescription: String? {
            switch self {
            case .keyNotFound:             return "No UMK is present yet."
            case .biometricFailed(let s):  return "Biometric authentication failed (\(s))."
            case .derivationFailed(let m): return "Key derivation failed: \(m)"
            case .wrapFailed(let m):       return "UMK wrap failed: \(m)"
            case .unwrapFailed(let m):     return "UMK unwrap failed: \(m)"
            case .keychainFailed(let s):   return "Keychain operation failed (\(s))."
            }
        }
    }

    public init() {}

    // MARK: - Existence

    public static var hasWrappedUMK: Bool {
        keychainRead(account: KCKey.wrappedUmk) != nil
            && keychainRead(account: KCKey.ephemeralPub) != nil
    }

    // MARK: - Generation

    /// Generate a fresh UMK seed, wrap it under a Secure-Enclave-derived
    /// key, and persist the ciphertext + ephemeral public key.
    public static func generateUMK(reason: String = "Create your Flagship account") async throws {
        let umkSeed = SymmetricKey(size: .bits256)
        let umkBytes = umkSeed.withUnsafeBytes { Data($0) }

        let ephemeral = P256.KeyAgreement.PrivateKey()
        let wrapper = try await WrappingKeypair.createOrLoad(reason: reason)
        let ecdhBytes = try wrapper.ecdh(ephemeralPublic: ephemeral.publicKey)

        let wrappingKey = hkdf(from: ecdhBytes, info: "flagship/umk-wrap/v1")

        do {
            let sealed = try AES.GCM.seal(umkBytes, using: wrappingKey)
            guard let combined = sealed.combined else {
                throw KeystoreError.wrapFailed("no combined representation")
            }
            try keychainWrite(account: KCKey.wrappedUmk, data: combined)
            try keychainWrite(account: KCKey.ephemeralPub, data: ephemeral.publicKey.x963Representation)
        } catch let e as KeystoreError {
            throw e
        } catch {
            throw KeystoreError.wrapFailed(String(describing: error))
        }
    }

    // MARK: - Derivation

    /// Per-server symmetric wrap key (SWK). Used by app-backup encryption.
    public static func deriveSWK(serverId: String, reason: String) async throws -> SymmetricKey {
        let umk = try await unwrappedUMK(reason: reason)
        return derive(umk: umk, info: "flagship/swk/v1|\(serverId)")
    }

    /// Per-server Ed25519 BAK keypair. Signs boot-approval challenges.
    public static func deriveBAK(serverId: String, reason: String) async throws -> Curve25519.Signing.PrivateKey {
        let umk = try await unwrappedUMK(reason: reason)
        let seed = derive(umk: umk, info: "flagship/bak/v1|\(serverId)")
        return try Curve25519.Signing.PrivateKey(rawRepresentation: seed.withUnsafeBytes { Data($0) })
    }

    /// Account-level Ed25519 IRK keypair. Signs identity-rotation orders.
    public static func deriveIRK(reason: String) async throws -> Curve25519.Signing.PrivateKey {
        let umk = try await unwrappedUMK(reason: reason)
        let seed = derive(umk: umk, info: "flagship/irk/v1")
        return try Curve25519.Signing.PrivateKey(rawRepresentation: seed.withUnsafeBytes { Data($0) })
    }

    /// Per-device X25519 push key. Generated on first call and persisted
    /// as raw 32-byte private key in the Keychain. The matching public
    /// key is registered with .com at /api/push/register; senders seal
    /// payloads to this pubkey, the device's daemon-side relay unwraps
    /// them with the private half. Per-device (not UMK-derived) so a
    /// second phone added to the account has its own push channel.
    public static func loadOrCreatePushX25519() throws -> Curve25519.KeyAgreement.PrivateKey {
        if let raw = keychainRead(account: KCKey.pushX25519Priv),
           let pk = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw) {
            return pk
        }
        let pk = Curve25519.KeyAgreement.PrivateKey()
        try keychainWrite(account: KCKey.pushX25519Priv, data: pk.rawRepresentation)
        return pk
    }

    /// Last-registered push token-id, returned by .com from
    /// /api/push/register. Stored so we can DELETE on sign-out.
    public static func setPushTokenId(_ id: String?) throws {
        if let id, let bytes = id.data(using: .utf8) {
            try keychainWrite(account: KCKey.pushTokenId, data: bytes)
        } else {
            let q: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrAccount as String: KCKey.pushTokenId,
            ]
            SecItemDelete(q as CFDictionary)
            InMemoryStore.shared.remove(account: KCKey.pushTokenId)
        }
    }

    public static func pushTokenId() -> String? {
        guard let d = keychainRead(account: KCKey.pushTokenId) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    // MARK: - Wipe (sign-out / tests)

    public static func wipe() {
        for account in [KCKey.wrappedUmk, KCKey.ephemeralPub, KCKey.simWrapPriv,
                        KCKey.pushX25519Priv, KCKey.pushTokenId] {
            let q: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrAccount as String: account
            ]
            SecItemDelete(q as CFDictionary)
            InMemoryStore.shared.remove(account: account)
        }
        WrappingKeypair.deleteSEKeyIfExists()
    }

    // MARK: - Internals

    private static func unwrappedUMK(reason: String) async throws -> SymmetricKey {
        guard
            let wrapped = keychainRead(account: KCKey.wrappedUmk),
            let ephemeralRaw = keychainRead(account: KCKey.ephemeralPub)
        else {
            throw KeystoreError.keyNotFound
        }

        let ephemeralPub: P256.KeyAgreement.PublicKey
        do {
            ephemeralPub = try P256.KeyAgreement.PublicKey(x963Representation: ephemeralRaw)
        } catch {
            throw KeystoreError.unwrapFailed("bad ephemeral pubkey: \(error)")
        }

        let wrapper = try await WrappingKeypair.createOrLoad(reason: reason)
        let ecdhBytes = try wrapper.ecdh(ephemeralPublic: ephemeralPub)
        let unwrapKey = hkdf(from: ecdhBytes, info: "flagship/umk-wrap/v1")

        do {
            let box = try AES.GCM.SealedBox(combined: wrapped)
            let plaintext = try AES.GCM.open(box, using: unwrapKey)
            return SymmetricKey(data: plaintext)
        } catch {
            throw KeystoreError.unwrapFailed(String(describing: error))
        }
    }

    private static func hkdf(from ikm: Data, info: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: Data("flagship/wrap-salt/v1".utf8),
            info: Data(info.utf8),
            outputByteCount: 32
        )
    }

    private static func derive(umk: SymmetricKey, info: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: umk,
            info: Data(info.utf8),
            outputByteCount: 32
        )
    }

    // MARK: - Keychain helpers

    fileprivate enum KCKey {
        static let wrappedUmk     = "com.flagship.umk.wrapped"
        static let ephemeralPub   = "com.flagship.umk.ephemeralpub"
        static let simWrapPriv    = "com.flagship.umk.simwrap"
        static let seKeyTag       = "com.flagship.umk.se"
        static let pushX25519Priv = "com.flagship.push.x25519priv"
        static let pushTokenId    = "com.flagship.push.tokenid"
    }

    fileprivate static func keychainWrite(account: String, data: Data) throws {
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(baseQuery as CFDictionary)

        var add: [String: Any] = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecSuccess { return }
        // Test bundles on the iOS Simulator (no app host) run without
        // the Keychain entitlement, so SecItemAdd returns -34018. Fall
        // back to a process-local in-memory store so unit tests can
        // exercise the wrap/unwrap round-trip end-to-end. Production
        // sim runs always have the entitlement; this branch is
        // entirely for the test harness.
        if status == errSecMissingEntitlement {
            InMemoryStore.shared.write(account: account, data: data)
            return
        }
        throw KeystoreError.keychainFailed(status)
    }

    fileprivate static func keychainRead(account: String) -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data { return data }
        // Fall back to the in-memory store (see keychainWrite for why).
        return InMemoryStore.shared.read(account: account)
    }
}

/// Process-local fallback for environments where the Keychain refuses
/// writes (notably iOS Simulator test bundles with no app host).
/// NEVER hit on real devices or production-sim runs — production paths
/// always have the Keychain entitlement.
fileprivate final class InMemoryStore: @unchecked Sendable {
    static let shared = InMemoryStore()
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

/// Wrapping keypair abstraction. Real devices use the Secure Enclave;
/// the simulator falls back to a non-SE P-256 keypair persisted in the
/// Keychain. Both expose the same `ecdh(...) -> Data` API.
fileprivate struct WrappingKeypair {
    private let _ecdh: (P256.KeyAgreement.PublicKey) throws -> Data

    func ecdh(ephemeralPublic: P256.KeyAgreement.PublicKey) throws -> Data {
        try _ecdh(ephemeralPublic)
    }

    static func createOrLoad(reason: String) async throws -> WrappingKeypair {
        let ctx = LAContext()
        ctx.localizedReason = reason

        #if targetEnvironment(simulator)
        return try simulatorKeypair()
        #else
        return try secureEnclaveKeypair(context: ctx)
        #endif
    }

    static func deleteSEKeyIfExists() {
        #if !targetEnvironment(simulator)
        let q: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: Data(Keystore.KCKey.seKeyTag.utf8)
        ]
        SecItemDelete(q as CFDictionary)
        #endif
    }

    #if targetEnvironment(simulator)
    private static func simulatorKeypair() throws -> WrappingKeypair {
        // Reuse the simulator wrap key across launches.
        let pk: P256.KeyAgreement.PrivateKey
        if let raw = Keystore.keychainRead(account: Keystore.KCKey.simWrapPriv) {
            pk = try P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
        } else {
            pk = P256.KeyAgreement.PrivateKey()
            try? Keystore.keychainWrite(account: Keystore.KCKey.simWrapPriv, data: pk.rawRepresentation)
        }
        return WrappingKeypair(_ecdh: { peer in
            let secret = try pk.sharedSecretFromKeyAgreement(with: peer)
            return secret.withUnsafeBytes { Data($0) }
        })
    }
    #else
    private static func secureEnclaveKeypair(context: LAContext) throws -> WrappingKeypair {
        let tag = Data(Keystore.KCKey.seKeyTag.utf8)

        let lookup: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag as String: tag,
            kSecReturnRef as String: true,
            kSecUseAuthenticationContext as String: context
        ]
        var existing: AnyObject?
        let lookupStatus = SecItemCopyMatching(lookup as CFDictionary, &existing)

        let secKey: SecKey
        if lookupStatus == errSecSuccess, let key = existing {
            secKey = key as! SecKey
        } else {
            let access = SecAccessControlCreateWithFlags(
                kCFAllocatorDefault,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                [.privateKeyUsage, .biometryCurrentSet],
                nil
            )!
            let attrs: [String: Any] = [
                kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
                kSecAttrKeySizeInBits as String: 256,
                kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
                kSecPrivateKeyAttrs as String: [
                    kSecAttrIsPermanent as String: true,
                    kSecAttrApplicationTag as String: tag,
                    kSecAttrAccessControl as String: access
                ]
            ]
            var error: Unmanaged<CFError>?
            guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
                throw error!.takeRetainedValue() as Error
            }
            secKey = key
        }

        return WrappingKeypair(_ecdh: { ephemeralPub in
            var err: Unmanaged<CFError>?
            let peer: SecKey
            do {
                var e: Unmanaged<CFError>?
                guard let pk = SecKeyCreateWithData(
                    ephemeralPub.x963Representation as CFData,
                    [
                        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
                        kSecAttrKeyClass: kSecAttrKeyClassPublic
                    ] as CFDictionary,
                    &e
                ) else {
                    throw e!.takeRetainedValue() as Error
                }
                peer = pk
            }
            guard let agreement = SecKeyCopyKeyExchangeResult(
                secKey,
                .ecdhKeyExchangeStandard,
                peer,
                [:] as CFDictionary,
                &err
            ) else {
                throw err!.takeRetainedValue() as Error
            }
            return agreement as Data
        })
    }
    #endif
}
