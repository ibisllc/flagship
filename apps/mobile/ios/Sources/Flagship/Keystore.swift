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

    // MARK: - Multi-profile (per-profile keying)

    /// Sentinel profileId for the legacy / default slot. When the active
    /// profile is this (or nil / empty), every per-profile Keychain item
    /// uses the EXACT legacy account string — so on-disk layout and
    /// behavior are byte-identical to the single-profile era. Non-default
    /// profiles get a `.<profileId>` account suffix.
    public static let defaultProfileId = "__default__"

    /// Account string under which the active-profile pointer is persisted.
    /// This pointer itself is device-global (one per app), so it lives
    /// under a fixed legacy-style account, never suffixed.
    private static let activeProfilePointerAccount = "com.flagship.profile.active"

    /// In-process cache of the active profileId. Lazily hydrated from the
    /// persisted pointer on first access so a fresh launch resumes the
    /// last-active profile without an explicit `setActiveProfile`.
    private static var _activeProfileId: String?
    private static var _activeProfileHydrated = false
    private static let activeProfileLock = NSLock()

    /// Normalize a caller-supplied profileId to the canonical slot key.
    /// nil / empty / whitespace-only → the default sentinel. Otherwise
    /// trimmed + lowercased (the profileId is the profile's `cloudName`,
    /// lowercased — mirrored on Android/webapp).
    private static func normalizeProfileId(_ id: String?) -> String {
        guard let id else { return defaultProfileId }
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? defaultProfileId : trimmed
    }

    /// The active profileId, hydrating from the persisted pointer once.
    public static var activeProfileId: String {
        activeProfileLock.lock(); defer { activeProfileLock.unlock() }
        if !_activeProfileHydrated {
            if let d = keychainRead(account: activeProfilePointerAccount),
               let s = String(data: d, encoding: .utf8) {
                _activeProfileId = normalizeProfileId(s)
            } else {
                _activeProfileId = defaultProfileId
            }
            _activeProfileHydrated = true
        }
        return _activeProfileId ?? defaultProfileId
    }

    /// Point every subsequent per-profile operation at `id`'s slot.
    /// nil / empty → the legacy default slot. The pointer is persisted so
    /// the next launch resumes the same profile. Calling with the default
    /// sentinel restores byte-identical legacy behavior.
    public static func setActiveProfile(_ id: String?) {
        let normalized = normalizeProfileId(id)
        activeProfileLock.lock()
        _activeProfileId = normalized
        _activeProfileHydrated = true
        activeProfileLock.unlock()
        // Persist the pointer (device-global, never suffixed). The default
        // sentinel is stored too so an explicit reset survives relaunch.
        try? keychainWrite(account: activeProfilePointerAccount,
                           data: Data(normalized.utf8))
    }

    /// Map a legacy base account string to the active profile's slot.
    /// The default profile returns the base UNCHANGED (byte-identical to
    /// the single-profile layout); non-default profiles get a
    /// `.<profileId>` suffix (e.g. `com.flagship.umk.wrapped.jay-family`).
    private static func account(_ base: String) -> String {
        account(base, profile: activeProfileId)
    }

    private static func account(_ base: String, profile: String) -> String {
        let normalized = normalizeProfileId(profile)
        return normalized == defaultProfileId ? base : "\(base).\(normalized)"
    }

    // MARK: - Existence

    public static var hasWrappedUMK: Bool {
        keychainRead(account: account(KCKey.wrappedUmk)) != nil
            && keychainRead(account: account(KCKey.ephemeralPub)) != nil
    }

    // MARK: - Generation

    /// Generate a fresh UMK seed, wrap it under a Secure-Enclave-derived
    /// key, and persist the ciphertext + ephemeral public key.
    public static func generateUMK(reason: String = "Create your Flagship account") async throws {
        try await installUMK(SymmetricKey(size: .bits256), reason: reason)
    }

    /// E2 — atomically install a pre-existing UMK seed. Used by the
    /// Wipe & restart ceremony: the caller has just generated a fresh
    /// 32-byte UMK locally (so the ceremony can sign the canonical
    /// bytes with the OLD IRK derived from the OLD UMK before we
    /// overwrite). After this returns, deriveIRK() / deriveBAK() /
    /// deriveSWK() all derive against the NEW UMK.
    ///
    /// Also resets the IRK version slot to v1 and clears any pending
    /// rotation, so the new IRK is `HKDF(newUMK, "flagship/irk/v1")`.
    public static func installUMK(_ umkSeed: SymmetricKey, reason: String) async throws {
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
            try keychainWrite(account: account(KCKey.wrappedUmk), data: combined)
            try keychainWrite(account: account(KCKey.ephemeralPub), data: ephemeral.publicKey.x963Representation)
            // Reset the IRK version state — fresh UMK → fresh v1 IRK.
            try setCurrentIrkVersion(1)
            try setPendingIrkRotationVersion(nil)
        } catch let e as KeystoreError {
            throw e
        } catch {
            throw KeystoreError.wrapFailed(String(describing: error))
        }
    }

    /// Convenience: point at `profile`'s slot, then install. nil → the
    /// default/legacy slot. Equivalent to `setActiveProfile(profile)`
    /// followed by `installUMK(_:reason:)` — the active-pointer approach
    /// is primary, but add-profile flows can use this to land a new
    /// profile's UMK in its own slot in one call.
    public static func installUMK(_ umkSeed: SymmetricKey, reason: String, profile: String?) async throws {
        setActiveProfile(profile)
        try await installUMK(umkSeed, reason: reason)
    }

    /// E2 — read the current UMK as raw bytes. Used by the Wipe
    /// ceremony to surface the OLD UMK seed for hashing / comparison
    /// before installing a new one. The biometric prompt fires under
    /// the hood since UMK lives behind WrappingKeypair.
    public static func currentUMK(reason: String) async throws -> SymmetricKey {
        return try await unwrappedUMK(reason: reason)
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
    ///
    /// Reads `currentIrkVersion()` from Keychain (defaulting to v1 on
    /// first launch / legacy installs) and derives via
    /// `HKDF(umk, "flagship/irk/v<N>")`. The version slot is bumped
    /// by Replace device (B7) and Wipe & restart (E2), invalidating
    /// any leaked-disk OLD IRK private key on a stolen peer device.
    public static func deriveIRK(reason: String) async throws -> Curve25519.Signing.PrivateKey {
        return try await deriveIRK(reason: reason, version: currentIrkVersion())
    }

    /// Explicit-version variant. Used by the Replace device + Wipe
    /// ceremonies to derive BOTH the OLD (current N) and the NEW
    /// (N+1) IRK during a rotation, without first persisting the
    /// new version (which only happens after the server CAS succeeds).
    public static func deriveIRK(reason: String, version: Int) async throws -> Curve25519.Signing.PrivateKey {
        let umk = try await unwrappedUMK(reason: reason)
        let seed = derive(umk: umk, info: "flagship/irk/v\(version)")
        return try Curve25519.Signing.PrivateKey(rawRepresentation: seed.withUnsafeBytes { Data($0) })
    }

    /// Current IRK HKDF version. Defaults to 1 if the slot is absent
    /// — covers legacy installs that pre-date the rotation primitive.
    public static func currentIrkVersion() -> Int {
        guard let d = keychainRead(account: account(KCKey.irkVersion)),
              let s = String(data: d, encoding: .utf8),
              let n = Int(s),
              n >= 1
        else { return 1 }
        return n
    }

    /// Persist a new IRK version. Caller is expected to have just
    /// successfully completed a server-side IRK swap via either
    /// `/api/users/:u/re-pair/complete` or `/api/users/:u/wipe-restart`.
    /// Bumping locally before the server confirms would brick this
    /// device's ability to sign — every operation would derive a
    /// version the server doesn't know about.
    public static func setCurrentIrkVersion(_ version: Int) throws {
        precondition(version >= 1, "IRK version must be >= 1")
        try keychainWrite(account: account(KCKey.irkVersion), data: Data(String(version).utf8))
    }

    // Optional "pending re-pair" marker — lets a future app launch
    // see that a rotation is in flight (Replace device initiated but
    // not yet completed) and decide whether to poll the server's
    // complete endpoint. Stored as the pending version number; absent
    // means no pending rotation.

    public static func pendingIrkRotationVersion() -> Int? {
        guard let d = keychainRead(account: account(KCKey.irkPendingVersion)),
              let s = String(data: d, encoding: .utf8),
              let n = Int(s),
              n >= 1
        else { return nil }
        return n
    }

    public static func setPendingIrkRotationVersion(_ version: Int?) throws {
        let acct = account(KCKey.irkPendingVersion)
        if let version {
            precondition(version >= 1, "pending IRK version must be >= 1")
            try keychainWrite(account: acct, data: Data(String(version).utf8))
        } else {
            keychainDelete(account: acct)
        }
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
            keychainDelete(account: KCKey.pushTokenId)
        }
    }

    public static func pushTokenId() -> String? {
        guard let d = keychainRead(account: KCKey.pushTokenId) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    // MARK: - Wipe (sign-out / tests)

    /// Wipe ONLY the active profile's key slots — so signing out of one
    /// profile (or self-revoking the current account) doesn't nuke the
    /// other profiles' device keys. For the default profile the cleared
    /// set + on-disk behavior is byte-identical to the historical wipe
    /// (it also clears the device-global push channel, since the legacy
    /// single-profile install owned it). Non-default profiles clear only
    /// their suffixed UMK / ephemeral / sim-wrap / IRK slots + their own
    /// Secure-Enclave wrapping key; device-global push keys + the active-
    /// profile pointer survive. Use `wipeAllProfiles()` for a full reset.
    public static func wipe() {
        let id = activeProfileId
        var accounts = [account(KCKey.wrappedUmk, profile: id),
                        account(KCKey.ephemeralPub, profile: id),
                        account(KCKey.simWrapPriv, profile: id),
                        account(KCKey.irkVersion, profile: id),
                        account(KCKey.irkPendingVersion, profile: id)]
        if id == defaultProfileId {
            // Legacy parity: the default install owned the device push channel.
            accounts.append(KCKey.pushX25519Priv)
            accounts.append(KCKey.pushTokenId)
        }
        for account in accounts {
            keychainDelete(account: account)
        }
        WrappingKeypair.deleteSEKeyIfExists(profile: id)
    }

    /// Full reset across EVERY profile + device-global keys. Currently
    /// only the active-profile + default device-global slots are wiped
    /// (there's no enumeration of arbitrary profile suffixes in the
    /// Keychain); callers that need a profile-by-profile sweep should
    /// `setActiveProfile` + `wipe()` per known profile, then call this.
    /// Provided so a deliberate "reset this device entirely" path has a
    /// named home distinct from the per-profile `wipe()`.
    public static func wipeAllProfiles() {
        // Clear the active profile's slot, the legacy/default slot, and
        // the device-global push channel + active pointer.
        let known = Set([activeProfileId, defaultProfileId])
        for id in known {
            for base in [KCKey.wrappedUmk, KCKey.ephemeralPub, KCKey.simWrapPriv,
                         KCKey.irkVersion, KCKey.irkPendingVersion] {
                keychainDelete(account: account(base, profile: id))
            }
            WrappingKeypair.deleteSEKeyIfExists(profile: id)
        }
        keychainDelete(account: KCKey.pushX25519Priv)
        keychainDelete(account: KCKey.pushTokenId)
        keychainDelete(account: activeProfilePointerAccount)
        activeProfileLock.lock()
        _activeProfileId = defaultProfileId
        _activeProfileHydrated = true
        activeProfileLock.unlock()
    }

    // MARK: - Internals

    private static func unwrappedUMK(reason: String) async throws -> SymmetricKey {
        guard
            let wrapped = keychainRead(account: account(KCKey.wrappedUmk)),
            let ephemeralRaw = keychainRead(account: account(KCKey.ephemeralPub))
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
        static let wrappedUmk          = "com.flagship.umk.wrapped"
        static let ephemeralPub        = "com.flagship.umk.ephemeralpub"
        static let simWrapPriv         = "com.flagship.umk.simwrap"
        static let seKeyTag            = "com.flagship.umk.se"
        static let pushX25519Priv      = "com.flagship.push.x25519priv"
        static let pushTokenId         = "com.flagship.push.tokenid"
        /// B7/E2 — HKDF version counter for IRK derivation. Absent → v1. */
        static let irkVersion          = "com.flagship.irk.version"
        /// B7 — pending re-pair target version while a rotation is
        /// in flight. Cleared on completion or abort. */
        static let irkPendingVersion   = "com.flagship.irk.pendingVersion"
    }

    /// The active profile's sim-wrap Keychain account (default → legacy).
    fileprivate static func profileScopedSimWrapAccount() -> String {
        account(KCKey.simWrapPriv)
    }

    /// The active profile's Secure-Enclave application tag (default →
    /// legacy). Non-default profiles suffix the tag so each profile's
    /// wrapping key is distinct.
    fileprivate static func profileScopedSEKeyTag(profile: String? = nil) -> String {
        account(KCKey.seKeyTag, profile: profile ?? activeProfileId)
    }

    fileprivate static func keychainWrite(account: String, data: Data) throws {
        try keychainWrite(account: account, data: data, sync: .cloudRoot)
    }

    /// W8 — write a Keychain item under the iCloud-sync class indicated
    /// by `sync`. `.cloudRoot` keys (the IRK / wrapped UMK / ephemeral
    /// pubkey — anything that represents the CLOUD root identity) set
    /// `kSecAttrSynchronizable=true` so iCloud Keychain replicates them
    /// across the user's Apple-ID devices; restoring on a new iPad
    /// pulls them through. `.deviceLocal` keys (per-device device-IRKs,
    /// not yet shipped) set the flag to false so a restored device
    /// MUST mint its own device key rather than cloning an existing
    /// device's identity.
    internal static func keychainWrite(account: String, data: Data, sync: KeychainSyncClass) throws {
        // We must filter by Synchronizable to avoid stale ghost entries
        // from a prior class. Without Synchronizable, SecItemDelete only
        // matches non-synced items; an existing synced item under the
        // same account would silently shadow the new write.
        var baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account
        ]
        baseQuery[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
        SecItemDelete(baseQuery as CFDictionary)

        var add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account
        ]
        add[kSecValueData as String] = data
        switch sync {
        case .cloudRoot:
            add[kSecAttrSynchronizable as String] = kCFBooleanTrue
            // iCloud-syncing items can't use *ThisDeviceOnly accessibility.
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        case .deviceLocal:
            add[kSecAttrSynchronizable as String] = kCFBooleanFalse
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        }
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecSuccess { return }
        // Test bundles on the iOS Simulator (no app host) run without
        // the Keychain entitlement, so SecItemAdd returns -34018. Fall
        // back to a process-local in-memory store so unit tests can
        // exercise the wrap/unwrap round-trip end-to-end. Production
        // sim runs always have the entitlement; this branch is
        // entirely for the test harness.
        if status == errSecMissingEntitlement {
            InMemoryStore.shared.write(account: account, data: data, sync: sync)
            return
        }
        throw KeystoreError.keychainFailed(status)
    }

    /// Delete a Generic-Password Keychain item + its in-memory mirror.
    /// Matches the legacy ad-hoc delete query (no Synchronizable filter)
    /// so the default-profile on-disk behavior is unchanged.
    fileprivate static func keychainDelete(account: String) {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(q as CFDictionary)
        InMemoryStore.shared.remove(account: account)
    }

    fileprivate static func keychainRead(account: String) -> Data? {
        // Read matches BOTH synced and non-synced items so a legacy
        // device-local UMK can still be unlocked by code that now stores
        // new writes under .cloudRoot. The first match wins.
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data { return data }
        // Fall back to the in-memory store (see keychainWrite for why).
        return InMemoryStore.shared.read(account: account)
    }
}

/// W8 — iCloud Keychain sync class for stored items.
///
///   - `.cloudRoot` items set `kSecAttrSynchronizable=true`. The cloud
///     root identity (today's wrapped UMK / IRK / ephemeral pubkey)
///     MUST sync so iCloud-restore on a new device pulls the same
///     identity through.
///   - `.deviceLocal` items set `kSecAttrSynchronizable=false`. Per-
///     device device-IRKs (not yet shipped — we still hold the cloud
///     IRK directly) MUST NOT sync; an iPad restored from another
///     iPad's iCloud backup needs to mint its OWN device IRK rather
///     than cloning the source iPad's identity. The enum is plumbed
///     in today so the future device-IRK split has a typed home.
public enum KeychainSyncClass: Sendable, Equatable {
    case cloudRoot
    case deviceLocal
}

/// Process-local fallback for environments where the Keychain refuses
/// writes (notably iOS Simulator test bundles with no app host).
/// NEVER hit on real devices or production-sim runs — production paths
/// always have the Keychain entitlement.
final class InMemoryStore: @unchecked Sendable {
    static let shared = InMemoryStore()
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    /// W8 test surface — last-write sync class per account. Production
    /// reads ignore this; KeychainSyncClassTests asserts on it to verify
    /// that `keychainWrite(..., sync:)` plumbs the flag through.
    private var syncClasses: [String: KeychainSyncClass] = [:]

    func read(account: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return items[account]
    }
    func write(account: String, data: Data) {
        write(account: account, data: data, sync: .cloudRoot)
    }
    func write(account: String, data: Data, sync: KeychainSyncClass) {
        lock.lock(); defer { lock.unlock() }
        items[account] = data
        syncClasses[account] = sync
    }
    func remove(account: String) {
        lock.lock(); defer { lock.unlock() }
        items.removeValue(forKey: account)
        syncClasses.removeValue(forKey: account)
    }
    /// W8 test-only — last-write sync class for `account`, or nil if
    /// nothing has been written.
    func syncClass(account: String) -> KeychainSyncClass? {
        lock.lock(); defer { lock.unlock() }
        return syncClasses[account]
    }
}

/// W8 test surface — internal accessors for the in-memory fallback
/// store. Lives at module scope so the test target can call them
/// without piercing `fileprivate`.
public enum KeystoreTestSupport {
    /// Write through the production keychainWrite path under the chosen
    /// sync class. On the simulator test bundle this lands in the
    /// in-memory store (no Keychain entitlement); the result is
    /// observable via `lastWrittenSyncClass`.
    public static func write(account: String, data: Data, sync: KeychainSyncClass) throws {
        try Keystore.keychainWrite(account: account, data: data, sync: sync)
    }
    /// The sync class the in-memory fallback recorded for the last write
    /// to `account`. Nil before the first write.
    public static func lastWrittenSyncClass(account: String) -> KeychainSyncClass? {
        InMemoryStore.shared.syncClass(account: account)
    }
    /// Clear the in-memory store so test ordering doesn't leak.
    public static func wipeInMemory(account: String) {
        InMemoryStore.shared.remove(account: account)
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

        // Each profile gets its OWN wrapping keypair so a profile's UMK
        // can only be unwrapped under its own slot. The default profile
        // resolves to the legacy account / SE tag (byte-identical).
        let simAccount = Keystore.profileScopedSimWrapAccount()
        let seTag = Keystore.profileScopedSEKeyTag()

        #if targetEnvironment(simulator)
        return try simulatorKeypair(account: simAccount)
        #else
        return try secureEnclaveKeypair(context: ctx, tag: Data(seTag.utf8))
        #endif
    }

    static func deleteSEKeyIfExists(profile: String) {
        #if !targetEnvironment(simulator)
        let q: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: Data(Keystore.profileScopedSEKeyTag(profile: profile).utf8)
        ]
        SecItemDelete(q as CFDictionary)
        #endif
    }

    #if targetEnvironment(simulator)
    private static func simulatorKeypair(account: String) throws -> WrappingKeypair {
        // Reuse the simulator wrap key across launches.
        let pk: P256.KeyAgreement.PrivateKey
        if let raw = Keystore.keychainRead(account: account) {
            pk = try P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
        } else {
            pk = P256.KeyAgreement.PrivateKey()
            try? Keystore.keychainWrite(account: account, data: pk.rawRepresentation)
        }
        return WrappingKeypair(_ecdh: { peer in
            let secret = try pk.sharedSecretFromKeyAgreement(with: peer)
            return secret.withUnsafeBytes { Data($0) }
        })
    }
    #else
    private static func secureEnclaveKeypair(context: LAContext, tag: Data) throws -> WrappingKeypair {

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
