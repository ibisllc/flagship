import Foundation
import CryptoKit
import LocalAuthentication
import Security
import FlagshipCore

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

    /// A′ cert pinning — the IRK plus the new box's STK PUBLIC key, both
    /// derived in ONE biometric ceremony (a separate STK-pub call would
    /// re-unwrap the UMK and double-prompt Face ID during server creation).
    /// The STK pub mirrors the protocol path `deriveSTK(deriveSWK(UMK,
    /// serverId))` via `ServerKeys` (FlagshipCore) and is what
    /// `CertPinRegistry` verifies STK-signed daemon-status reports against —
    /// `.com`'s `identityPubKey` echo is NOT a trust input.
    public static func deriveIRKAndBoxStkPub(
        serverId: String,
        reason: String
    ) async throws -> (irk: Curve25519.Signing.PrivateKey, boxStkPub: Data) {
        let umk = try await unwrappedUMK(reason: reason)
        let irkSeed = derive(umk: umk, info: "flagship/irk/v\(currentIrkVersion())")
        let irk = try Curve25519.Signing.PrivateKey(
            rawRepresentation: irkSeed.withUnsafeBytes { Data($0) }
        )
        let umkData = umk.withUnsafeBytes { Data($0) }
        guard let stkPub = ServerKeys.deriveStkPub(umkSeed: umkData, serverId: serverId) else {
            throw KeystoreError.derivationFailed("box STK pubkey for \(serverId)")
        }
        return (irk, stkPub)
    }

    /// The box's Service Workload Key (SWK) as lowercase hex — the deterministic
    /// `HKDF-SHA256(UMK seed, info="flagship.swk.v1|<serverId>")` the daemon
    /// re-derives nowhere (the box can't: it has no UMK), so the phone provisions
    /// it at create-time as an UNSIGNED `swkHex` recipe sibling. This is the BOX
    /// SWK via `ServerKeys.deriveSwk` (DOTS) — the protocol/daemon derivation —
    /// NOT the app-backup `Keystore.deriveSWK` (SLASHES, `flagship/swk/v1|…`),
    /// which is a deliberately different key. The unambiguous name guards against
    /// confusing the two.
    public static func deriveBoxServiceWorkloadKey(serverId: String, reason: String) async throws -> String {
        let umk = try await unwrappedUMK(reason: reason)
        let umkData = umk.withUnsafeBytes { Data($0) }
        guard let swk = ServerKeys.deriveSwk(umkSeed: umkData, serverId: serverId) else {
            throw KeystoreError.derivationFailed("box SWK for \(serverId)")
        }
        return HexUtil.encode(swk)
    }

    /// A′ cert pinning + SWK provisioning in ONE biometric: the IRK, the new
    /// box's STK PUBLIC key, AND the box's deterministic SWK (hex), all derived
    /// from a single UMK unwrap (a separate SWK call would re-prompt Face ID
    /// during server creation). The SWK is the box-side `ServerKeys.deriveSwk`
    /// (DOTS) key — NOT the app-backup `deriveSWK` (slashes).
    public static func deriveIRKBoxStkAndSwk(
        serverId: String,
        reason: String
    ) async throws -> (irk: Curve25519.Signing.PrivateKey, boxStkPub: Data, boxSwkHex: String) {
        let umk = try await unwrappedUMK(reason: reason)
        let irkSeed = derive(umk: umk, info: "flagship/irk/v\(currentIrkVersion())")
        let irk = try Curve25519.Signing.PrivateKey(
            rawRepresentation: irkSeed.withUnsafeBytes { Data($0) }
        )
        let umkData = umk.withUnsafeBytes { Data($0) }
        guard let stkPub = ServerKeys.deriveStkPub(umkSeed: umkData, serverId: serverId) else {
            throw KeystoreError.derivationFailed("box STK pubkey for \(serverId)")
        }
        guard let swk = ServerKeys.deriveSwk(umkSeed: umkData, serverId: serverId) else {
            throw KeystoreError.derivationFailed("box SWK for \(serverId)")
        }
        return (irk, stkPub, HexUtil.encode(swk))
    }

    /// CGK provisioning twin of `deriveIRKBoxStkAndSwk` for per-service
    /// leadership (Phase 6): the IRK plus the per-CLOUD Cloud Gossip Key (hex) in
    /// ONE biometric. The CGK is `CloudGossip.deriveCGK(umk.seed)` — per cloud,
    /// NOT per server (no serverId), so it is the same key for every box of the
    /// account. The phone seals it to a box's REGISTERED identity at deposit time.
    public static func deriveIRKAndCgk(
        reason: String
    ) async throws -> (irk: Curve25519.Signing.PrivateKey, cgkHex: String) {
        let umk = try await unwrappedUMK(reason: reason)
        let irkSeed = derive(umk: umk, info: "flagship/irk/v\(currentIrkVersion())")
        let irk = try Curve25519.Signing.PrivateKey(
            rawRepresentation: irkSeed.withUnsafeBytes { Data($0) }
        )
        let umkData = umk.withUnsafeBytes { Data($0) }
        guard let cgk = CloudGossip.deriveCGK(umkSeed: umkData) else {
            throw KeystoreError.derivationFailed("cloud gossip key (CGK)")
        }
        return (irk, HexUtil.encode(cgk))
    }

    /// Stable Account Identity Key (AID) — the NON-rotating account identity
    /// (`HKDF(umk, "flagship/account-id/v1")`, via `ServiceInvite`), used for
    /// service-access gating: the friend signs the redeem/visit with it, and an
    /// author's recorded identity in invites. Distinct from the versioned IRK
    /// (which signs active orders). Behind one biometric. See
    /// docs/service-access-gating.md.
    public static func deriveAccountId(reason: String) async throws -> Curve25519.Signing.PrivateKey {
        let umk = try await unwrappedUMK(reason: reason)
        let umkData = umk.withUnsafeBytes { Data($0) }
        guard let aid = ServiceInvite.deriveAccountId(umkSeed: umkData) else {
            throw KeystoreError.derivationFailed("account identity key (AID)")
        }
        return aid
    }

    /// The household AEAD key (`HKDF(umk, "flagship/household-key/v1")`, via
    /// `ServiceInvite`) that seals the `{name, photo?}` invite bundle. Every
    /// device of the account derives the same key (so a sibling can open it);
    /// `.com` never holds the UMK → stores ciphertext only.
    public static func deriveHouseholdKey(reason: String) async throws -> Data {
        let umk = try await unwrappedUMK(reason: reason)
        let umkData = umk.withUnsafeBytes { Data($0) }
        guard let key = ServiceInvite.deriveHouseholdKey(umkSeed: umkData) else {
            throw KeystoreError.derivationFailed("household key")
        }
        return key
    }

    /// Gating v2 (Wave 3) author path: unwrap the UMK ONCE and return the author's
    /// stable AID PRIVATE key + the household key in one biometric. v2 SIGNS the
    /// create / revoke / list-query with the AID (not the rotating IRK), so the
    /// box-as-authority can verify against the stable owner key after an IRK
    /// rotation. The AID is also the listed/recorded inviter identity.
    public static func deriveInviteAuthorAidKeys(
        reason: String
    ) async throws -> (aid: Curve25519.Signing.PrivateKey, household: Data) {
        let umk = try await unwrappedUMK(reason: reason)
        let umkData = umk.withUnsafeBytes { Data($0) }
        guard let aid = ServiceInvite.deriveAccountId(umkSeed: umkData),
              let household = ServiceInvite.deriveHouseholdKey(umkSeed: umkData)
        else {
            throw KeystoreError.derivationFailed("invite author AID keys")
        }
        return (aid, household)
    }

    /// Gating v2 consumer path: the friend's PER-AUTHOR contact AID
    /// (`deriveContactAccountId(UMK, authorAID)`) for a given author — the
    /// redeem/visit/knock/accept signer they present (NOT the global AID). One
    /// biometric. `authorAidPub` comes from the invite link.
    public static func deriveContactAccountId(
        authorAidPub: Data,
        reason: String
    ) async throws -> Curve25519.Signing.PrivateKey {
        let umk = try await unwrappedUMK(reason: reason)
        let umkData = umk.withUnsafeBytes { Data($0) }
        guard let contact = ServiceInvite.deriveContactAccountId(umkSeed: umkData, authorAidPub: authorAidPub) else {
            throw KeystoreError.derivationFailed("contact account identity key")
        }
        return contact
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

    /// Account-open fast path — generate + install a fresh UMK and derive the
    /// account IRK from the SAME in-memory seed in ONE biometric ceremony.
    /// `installUMK`'s wrap step is the only Secure-Enclave private-key op (a
    /// single Face ID); deriving the IRK from the in-memory seed needs no
    /// second unwrap, so opening an account prompts ONCE instead of twice
    /// (the `generateUMK` + `deriveIRK` storm the user hit). The result is
    /// byte-identical to `deriveIRK()` run right after `generateUMK()`:
    /// `installUMK` resets the IRK version to v1 and we derive at that version.
    public static func generateUMKAndDeriveIRK(
        reason: String = "Open your Flagship account"
    ) async throws -> Curve25519.Signing.PrivateKey {
        let umkSeed = SymmetricKey(size: .bits256)
        try await installUMK(umkSeed, reason: reason)
        let seed = derive(umk: umkSeed, info: "flagship/irk/v\(currentIrkVersion())")
        return try Curve25519.Signing.PrivateKey(rawRepresentation: seed.withUnsafeBytes { Data($0) })
    }

    // MARK: - Admin master root (Slice D — device authority root)

    /// HKDF info string for the AES-GCM key that wraps the admin-root seed. A
    /// DIFFERENT info than the UMK wrap (`flagship/umk-wrap/v1`) so, even when
    /// both secrets ride the SAME Secure-Enclave ECDH secret (the single-Face-ID
    /// account-open path), they seal under distinct keys.
    private static let adminRootWrapInfo = "flagship/adminroot-wrap/v1"

    /// Is a sealed admin master root present for the active profile? Cheap +
    /// biometric-free (checks the sealed-seed slot AND the public-key slot).
    /// The signing gate (§8.3) keys off this: present ⇒ this device is an admin,
    /// sensitive orders sign under the admin root; absent ⇒ legacy owner-IRK.
    public static var hasAdminRoot: Bool {
        keychainRead(account: account(KCKey.adminRootWrapped)) != nil
            && keychainRead(account: account(KCKey.adminRootPub)) != nil
    }

    /// The active profile's admin-root PUBLIC key as lowercase hex, or nil if no
    /// admin root is sealed. Biometric-free (the pub is stored device-local but
    /// NOT secret) so account-claim / recipe-mint can pin it without a prompt.
    public static func adminRootPubHex() -> String? {
        guard let raw = keychainRead(account: account(KCKey.adminRootPub)) else { return nil }
        return HexUtil.encode(raw)
    }

    /// Account-open fast path (§1.2) — in ONE Secure-Enclave ECDH (a single Face
    /// ID) generate + install the UMK, derive the account IRK from the same
    /// in-memory seed, AND mint + seal a FRESH RANDOM admin master root.
    ///
    /// The admin root is a brand-new Ed25519 keypair, NOT derived from the UMK:
    /// the first device holds it ⇒ it is admin by default. Both secrets seal
    /// under keys derived from the ONE ECDH secret (distinct HKDF infos), so the
    /// wrap costs no extra biometric. The UMK/ephemeral land `.cloudRoot`
    /// (iCloud-synced identity); the admin root's three slots land `.deviceLocal`
    /// (never synced — the authority root stays on admin devices only).
    ///
    /// Returns the IRK (for the username claim + recipe signing) and the admin
    /// root's pubkey hex (published to `.com` at claim + pinned into the recipe
    /// AuthCode).
    public static func openAccountRoots(
        reason: String = "Open your Flagship account"
    ) async throws -> (irk: Curve25519.Signing.PrivateKey, adminRootPubHex: String) {
        let umkSeed = SymmetricKey(size: .bits256)
        let umkBytes = umkSeed.withUnsafeBytes { Data($0) }
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let wrapper = try await WrappingKeypair.createOrLoad(reason: reason)
        let ecdhBytes = try wrapper.ecdh(ephemeralPublic: ephemeral.publicKey)  // single biometric
        do {
            // 1. UMK — sealed + persisted exactly as installUMK does (cloudRoot).
            let umkWrapKey = hkdf(from: ecdhBytes, info: "flagship/umk-wrap/v1")
            let umkSealed = try AES.GCM.seal(umkBytes, using: umkWrapKey)
            guard let umkCombined = umkSealed.combined else {
                throw KeystoreError.wrapFailed("no combined representation")
            }
            try keychainWrite(account: account(KCKey.wrappedUmk), data: umkCombined)
            try keychainWrite(account: account(KCKey.ephemeralPub), data: ephemeral.publicKey.x963Representation)
            try setCurrentIrkVersion(1)
            try setPendingIrkRotationVersion(nil)

            // 2. Admin master root — fresh random Ed25519, sealed device-local
            //    under the SAME ECDH secret (distinct HKDF info) + its ephemeral.
            let adminKey = Curve25519.Signing.PrivateKey()
            let adminWrapKey = hkdf(from: ecdhBytes, info: adminRootWrapInfo)
            let adminSealed = try AES.GCM.seal(adminKey.rawRepresentation, using: adminWrapKey)
            guard let adminCombined = adminSealed.combined else {
                throw KeystoreError.wrapFailed("admin-root: no combined representation")
            }
            try keychainWrite(account: account(KCKey.adminRootWrapped), data: adminCombined, sync: .deviceLocal)
            try keychainWrite(account: account(KCKey.adminRootEphemeralPub), data: ephemeral.publicKey.x963Representation, sync: .deviceLocal)
            try keychainWrite(account: account(KCKey.adminRootPub), data: adminKey.publicKey.rawRepresentation, sync: .deviceLocal)

            let irkSeed = derive(umk: umkSeed, info: "flagship/irk/v\(currentIrkVersion())")
            let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: irkSeed.withUnsafeBytes { Data($0) })
            return (irk, HexUtil.encode(adminKey.publicKey.rawRepresentation))
        } catch let e as KeystoreError {
            throw e
        } catch {
            throw KeystoreError.wrapFailed(String(describing: error))
        }
    }

    /// Mint + seal a FRESH admin master root for the active profile (§1.2),
    /// returning its pubkey hex. Standalone twin of `openAccountRoots` for flows
    /// that already have a UMK (e.g. a retry after a partial open, or promoting
    /// this very device). One biometric (its own SE ECDH). Overwrites any
    /// existing admin-root slots — callers gate on `hasAdminRoot`.
    @discardableResult
    public static func generateAdminRoot(
        reason: String = "Create your Flagship admin key"
    ) async throws -> String {
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let wrapper = try await WrappingKeypair.createOrLoad(reason: reason)
        let ecdhBytes = try wrapper.ecdh(ephemeralPublic: ephemeral.publicKey)
        do {
            let adminKey = Curve25519.Signing.PrivateKey()
            let adminWrapKey = hkdf(from: ecdhBytes, info: adminRootWrapInfo)
            let sealed = try AES.GCM.seal(adminKey.rawRepresentation, using: adminWrapKey)
            guard let combined = sealed.combined else {
                throw KeystoreError.wrapFailed("admin-root: no combined representation")
            }
            try keychainWrite(account: account(KCKey.adminRootWrapped), data: combined, sync: .deviceLocal)
            try keychainWrite(account: account(KCKey.adminRootEphemeralPub), data: ephemeral.publicKey.x963Representation, sync: .deviceLocal)
            try keychainWrite(account: account(KCKey.adminRootPub), data: adminKey.publicKey.rawRepresentation, sync: .deviceLocal)
            return HexUtil.encode(adminKey.publicKey.rawRepresentation)
        } catch let e as KeystoreError {
            throw e
        } catch {
            throw KeystoreError.wrapFailed(String(describing: error))
        }
    }

    /// The admin master root's Ed25519 signing key, biometric-gated (like
    /// `deriveIRK`): unseal the device-local seed under the Secure-Enclave
    /// wrapping key. Signs sensitive/destructive orders (§8.3). Throws
    /// `.keyNotFound` if this device holds no admin root.
    public static func adminRootKey(
        reason: String = "Authorize an admin action"
    ) async throws -> Curve25519.Signing.PrivateKey {
        guard
            let wrapped = keychainRead(account: account(KCKey.adminRootWrapped)),
            let ephemeralRaw = keychainRead(account: account(KCKey.adminRootEphemeralPub))
        else {
            throw KeystoreError.keyNotFound
        }
        let ephemeralPub: P256.KeyAgreement.PublicKey
        do {
            ephemeralPub = try P256.KeyAgreement.PublicKey(x963Representation: ephemeralRaw)
        } catch {
            throw KeystoreError.unwrapFailed("admin-root: bad ephemeral pubkey: \(error)")
        }
        let wrapper = try await WrappingKeypair.createOrLoad(reason: reason)
        let ecdhBytes = try wrapper.ecdh(ephemeralPublic: ephemeralPub)
        let unwrapKey = hkdf(from: ecdhBytes, info: adminRootWrapInfo)
        do {
            let box = try AES.GCM.SealedBox(combined: wrapped)
            let seed = try AES.GCM.open(box, using: unwrapKey)
            return try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        } catch {
            throw KeystoreError.unwrapFailed(String(describing: error))
        }
    }

    /// The signing key for a SENSITIVE/destructive order (§8.3), GATED: if this
    /// device holds an admin master root, sign with it (the authority root);
    /// else fall back to the owner IRK (legacy, for pre-wipe accounts that have
    /// no admin root — the box/.com transition gate still accepts the IRK when
    /// no admin root is pinned). Canonical bytes are IDENTICAL either way — only
    /// the signing key changes. Non-sensitive orders (pairing, deposits) keep
    /// calling `deriveIRK` directly and are unaffected.
    public static func sensitiveOrderSigningKey(
        reason: String = "Authorize this action"
    ) async throws -> Curve25519.Signing.PrivateKey {
        if hasAdminRoot {
            return try await adminRootKey(reason: reason)
        }
        return try await deriveIRK(reason: reason)
    }

    /// Boot-unlock approval fast path — unwrap the UMK ONCE and derive every
    /// key the approve ceremony needs (account IRK + this server's BAK) from
    /// the same in-memory seed. Behind a memoizing provider this collapses the
    /// old 3–4 Face ID storm (mailbox fetch, unseal-with-BAK, unseal-with-IRK,
    /// response header, lease deposit) into ONE biometric. The returned keys
    /// are byte-identical to `deriveIRK()` + `deriveBAK(serverId:)`.
    public static func deriveApprovalKeys(
        serverId: String,
        reason: String
    ) async throws -> (irk: Curve25519.Signing.PrivateKey, bak: Curve25519.Signing.PrivateKey) {
        let umk = try await unwrappedUMK(reason: reason)
        let irkSeed = derive(umk: umk, info: "flagship/irk/v\(currentIrkVersion())")
        let bakSeed = derive(umk: umk, info: "flagship/bak/v1|\(serverId)")
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: irkSeed.withUnsafeBytes { Data($0) })
        let bak = try Curve25519.Signing.PrivateKey(rawRepresentation: bakSeed.withUnsafeBytes { Data($0) })
        return (irk, bak)
    }

    /// Slice D boot-approval fast path — `deriveApprovalKeys` PLUS the admin
    /// master root, all under ONE biometric. The first-boot approval both
    /// releases the disk key (IRK/BAK) AND mints the RootEntitlement that
    /// authorizes the box to serve (admin-root-signed on a reburned admin-pinned
    /// box), so the ceremony needs both keys. Both the UMK and the admin-root
    /// seed seal under the SAME Secure-Enclave wrapping key (distinct HKDF
    /// infos), so a SINGLE `LAContext`/wrapper authenticates both ECDH unwraps —
    /// the admin root costs no second Face ID. `adminRoot` is nil when this
    /// device holds none (legacy / pre-wipe) ⇒ the caller signs the entitlement
    /// under the IRK. The IRK/BAK are byte-identical to `deriveApprovalKeys`.
    public static func deriveApprovalKeysWithAdminRoot(
        serverId: String,
        reason: String
    ) async throws -> (irk: Curve25519.Signing.PrivateKey, bak: Curve25519.Signing.PrivateKey, adminRoot: Curve25519.Signing.PrivateKey?) {
        guard
            let wrappedUmk = keychainRead(account: account(KCKey.wrappedUmk)),
            let umkEphRaw = keychainRead(account: account(KCKey.ephemeralPub))
        else {
            throw KeystoreError.keyNotFound
        }
        let umkEph: P256.KeyAgreement.PublicKey
        do {
            umkEph = try P256.KeyAgreement.PublicKey(x963Representation: umkEphRaw)
        } catch {
            throw KeystoreError.unwrapFailed("bad ephemeral pubkey: \(error)")
        }

        // ONE wrapper / LAContext ⇒ ONE biometric covers every ECDH below.
        let wrapper = try await WrappingKeypair.createOrLoad(reason: reason)

        // UMK → IRK + BAK (byte-identical to deriveApprovalKeys).
        let umkEcdh = try wrapper.ecdh(ephemeralPublic: umkEph)
        let umkKey = hkdf(from: umkEcdh, info: "flagship/umk-wrap/v1")
        let umk: SymmetricKey
        do {
            let plaintext = try AES.GCM.open(try AES.GCM.SealedBox(combined: wrappedUmk), using: umkKey)
            umk = SymmetricKey(data: plaintext)
        } catch {
            throw KeystoreError.unwrapFailed(String(describing: error))
        }
        let irkSeed = derive(umk: umk, info: "flagship/irk/v\(currentIrkVersion())")
        let bakSeed = derive(umk: umk, info: "flagship/bak/v1|\(serverId)")
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: irkSeed.withUnsafeBytes { Data($0) })
        let bak = try Curve25519.Signing.PrivateKey(rawRepresentation: bakSeed.withUnsafeBytes { Data($0) })

        // Admin master root (Slice D) — SAME wrapper, so no second prompt.
        // Absent slots ⇒ nil (legacy / pre-wipe): the caller signs under the IRK.
        var adminRoot: Curve25519.Signing.PrivateKey? = nil
        if
            let wrappedAdmin = keychainRead(account: account(KCKey.adminRootWrapped)),
            let adminEphRaw = keychainRead(account: account(KCKey.adminRootEphemeralPub)),
            let adminEph = try? P256.KeyAgreement.PublicKey(x963Representation: adminEphRaw)
        {
            let adminEcdh = try wrapper.ecdh(ephemeralPublic: adminEph)
            let adminKey = hkdf(from: adminEcdh, info: adminRootWrapInfo)
            do {
                let seed = try AES.GCM.open(try AES.GCM.SealedBox(combined: wrappedAdmin), using: adminKey)
                adminRoot = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
            } catch {
                throw KeystoreError.unwrapFailed("admin-root: \(error)")
            }
        }
        return (irk, bak, adminRoot)
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

    // MARK: - Watch delegate key (opt-in quick-approve)

    /// Load the active watch-delegate signing key, or mint a fresh one if
    /// none exists. Mirrors `loadOrCreatePushX25519`: a per-device Ed25519
    /// key persisted as raw bytes, NOT derived from the (biometric-gated)
    /// UMK — so signing a boot approval with it never prompts for Face ID
    /// while the phone is unlocked. The IRK attests this key's pubkey via a
    /// `WatchDelegateKey` envelope at enrollment; the cloud + boot worker
    /// accept its signature for boot approval ONLY.
    ///
    /// Stored `.deviceLocal` so it is bound to THIS device — a restored
    /// device inherits nothing and must re-enroll, matching the per-device
    /// opt-in model.
    public static func loadOrCreateWatchDelegateKey() throws -> Curve25519.Signing.PrivateKey {
        let acct = account(KCKey.watchDelegateSeed)
        if let raw = keychainRead(account: acct),
           let pk = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw) {
            return pk
        }
        let pk = Curve25519.Signing.PrivateKey()
        try keychainWrite(account: acct, data: pk.rawRepresentation, sync: .deviceLocal)
        return pk
    }

    /// The active watch-delegate key if one is enrolled on this device,
    /// else nil. The boot-approval signing path uses this: present ⇒ sign
    /// with the delegate (no prompt); absent ⇒ fall back to the IRK.
    public static func watchDelegateKey() -> Curve25519.Signing.PrivateKey? {
        guard let raw = keychainRead(account: account(KCKey.watchDelegateSeed)),
              let pk = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw)
        else { return nil }
        return pk
    }

    /// Persist / clear the active delegate's grantId — needed to mint the
    /// IRK-signed RevokeWatchDelegate when the toggle flips off.
    public static func setWatchDelegateGrantId(_ id: String?) throws {
        let acct = account(KCKey.watchDelegateGrantId)
        if let id, let bytes = id.data(using: .utf8) {
            try keychainWrite(account: acct, data: bytes, sync: .deviceLocal)
        } else {
            keychainDelete(account: acct)
        }
    }

    public static func watchDelegateGrantId() -> String? {
        guard let d = keychainRead(account: account(KCKey.watchDelegateGrantId)) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    /// Drop the delegate key + its grantId from this device. Called on
    /// toggle-off, Replace device, and Wipe & restart. The server-side
    /// revoke (IRK-signed) is the authority; this clears the local key so a
    /// stale device can't keep signing even before the revoke propagates.
    public static func clearWatchDelegate() {
        keychainDelete(account: account(KCKey.watchDelegateSeed))
        keychainDelete(account: account(KCKey.watchDelegateGrantId))
    }

    // MARK: - ACME account key (#28 — cert-minting authority)

    /// Load the profile's ACME account key (ECDSA P-256), minting a fresh
    /// one on first call. The raw 32-byte private scalar is persisted under
    /// `.cloudRoot` (iCloud-synced) so an iCloud-restored device inherits
    /// the same cert-minting authority, and is read back as a
    /// `P256.Signing.PrivateKey(rawRepresentation:)`.
    ///
    /// Unlike the UMK, this key is NOT biometric-gated and is stored
    /// exportably: cert issuance is a background operation that must not
    /// prompt for Face ID, and the raw scalar must be readable so it can be
    /// escrowed into the WebAuthn-PRF recovery envelope (see
    /// `AcmeAccountKey.wrapForEscrow`). The escrow is what makes losing
    /// every device non-fatal for issuance.
    public static func loadOrCreateAcmeAccountKey() throws -> P256.Signing.PrivateKey {
        let acct = account(KCKey.acmeAccountKeyScalar)
        if let raw = keychainRead(account: acct),
           let pk = try? P256.Signing.PrivateKey(rawRepresentation: raw) {
            return pk
        }
        let pk = P256.Signing.PrivateKey()
        try keychainWrite(account: acct, data: pk.rawRepresentation, sync: .cloudRoot)
        return pk
    }

    /// The profile's ACME account-key private scalar as raw bytes, or nil if
    /// none has been minted. Used by the recovery-enrollment path to escrow
    /// the key without forcing a (potentially prompting) keygen.
    public static func acmeAccountKeyScalar() -> Data? {
        keychainRead(account: account(KCKey.acmeAccountKeyScalar))
    }

    /// Install a recovered ACME account-key scalar into the profile's slot.
    /// Used by the recovery RESTORE path after `AcmeAccountKey.unwrapFromEscrow`
    /// yields the original 32-byte scalar. Validates that the bytes form a
    /// well-formed P-256 private key before writing.
    public static func importAcmeAccountKey(scalar: Data) throws {
        // Round-trips through CryptoKit so a malformed scalar throws here
        // rather than silently persisting an unusable key.
        _ = try P256.Signing.PrivateKey(rawRepresentation: scalar)
        try keychainWrite(account: account(KCKey.acmeAccountKeyScalar), data: scalar, sync: .cloudRoot)
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
                        account(KCKey.irkPendingVersion, profile: id),
                        account(KCKey.watchDelegateSeed, profile: id),
                        account(KCKey.watchDelegateGrantId, profile: id),
                        account(KCKey.acmeAccountKeyScalar, profile: id),
                        account(KCKey.adminRootWrapped, profile: id),
                        account(KCKey.adminRootEphemeralPub, profile: id),
                        account(KCKey.adminRootPub, profile: id)]
        if id == defaultProfileId {
            // Legacy parity: the default install owned the device push channel.
            accounts.append(KCKey.pushX25519Priv)
            accounts.append(KCKey.pushTokenId)
        }
        for account in accounts {
            keychainDelete(account: account)
        }
        WrappingKeypair.deleteSEKeyIfExists(profile: id)
        // The cert-pin STK-pub cache derives from this UMK — a wiped
        // account must not leave pins (or pub anchors) behind.
        CertPinRegistry.shared.clear()
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
                         KCKey.irkVersion, KCKey.irkPendingVersion,
                         KCKey.watchDelegateSeed, KCKey.watchDelegateGrantId,
                         KCKey.acmeAccountKeyScalar,
                         KCKey.adminRootWrapped, KCKey.adminRootEphemeralPub,
                         KCKey.adminRootPub] {
                keychainDelete(account: account(base, profile: id))
            }
            WrappingKeypair.deleteSEKeyIfExists(profile: id)
        }
        keychainDelete(account: KCKey.pushX25519Priv)
        keychainDelete(account: KCKey.pushTokenId)
        keychainDelete(account: activeProfilePointerAccount)
        // The per-profile loop above only knows {active, default}; a profile
        // created under any OTHER id leaves a stale wrappedUMK behind (the
        // Keychain survives an app delete+reinstall and accumulates across
        // accounts), and a leftover wrappedUMK whose Secure-Enclave key is gone
        // fails to unwrap on the next open-account ("authenticationFailure").
        // So a deliberate full reset sweeps EVERY flagship Keychain item by
        // class — generic passwords (wrapped UMK / ephemeral / sim-wrap / push /
        // irk-version / watch-delegate / acme) AND keys (the SE wrapping keys) —
        // scoped to this app's Keychain access group. Leaves nothing behind.
        //
        // kSecAttrSynchronizableAny is REQUIRED: the UMK / ephemeral / sim-wrap
        // are written `.cloudRoot` (kSecAttrSynchronizable=true), and a
        // SecItemDelete WITHOUT this attribute matches ONLY non-synced items —
        // so without it the wrapped UMK survived sign-out AND an app
        // delete+reinstall (iCloud Keychain restored it), letting Face ID
        // re-derive the supposedly-erased identity.
        for cls in [kSecClassGenericPassword, kSecClassKey] {
            SecItemDelete([
                kSecClass as String: cls,
                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            ] as CFDictionary)
        }
        activeProfileLock.lock()
        _activeProfileId = defaultProfileId
        _activeProfileHydrated = true
        activeProfileLock.unlock()
        CertPinRegistry.shared.clear()
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
        /// Watch delegate key — the raw 32-byte Ed25519 seed for the opt-in
        /// "quick approve a boot from the Watch" signing key. Stored
        /// `.deviceLocal` (NOT iCloud-synced, this-device-only) so it never
        /// rides a restore to another device + is readable while the phone is
        /// unlocked WITHOUT a biometric prompt — that silent-while-unlocked
        /// property is the whole point. The IRK stays biometric-gated. */
        static let watchDelegateSeed    = "com.flagship.watchdelegate.seed"
        /// The active delegate's grantId (UUID) — needed to build the
        /// IRK-signed RevokeWatchDelegate when the toggle flips off. */
        static let watchDelegateGrantId = "com.flagship.watchdelegate.grantid"
        /// #28 — the ACME account key's raw 32-byte P-256 private scalar.
        /// This is the authority to mint the user's TLS certs (ES256 LE
        /// account key). Stored EXPORTABLY + NON-biometric (cert issuance
        /// must not prompt for Face ID) + `.cloudRoot`-synced so an
        /// iCloud-restored device inherits it, AND escrowed into the
        /// WebAuthn-PRF recovery envelope so losing every device doesn't
        /// brick issuance. Profile-scoped like the UMK slots. */
        static let acmeAccountKeyScalar = "com.flagship.acme-account-key.scalar"
        /// Slice D (docs/device-admin-tier-spec.md §1.2) — the ADMIN MASTER
        /// ROOT: a fresh RANDOM Ed25519 seed (NOT UMK-derived) the first device
        /// mints at account creation, sealed AES-GCM under the profile's
        /// Secure-Enclave wrapping key (biometric, exactly like the UMK) and
        /// stored `.deviceLocal` (NON-synced, ThisDeviceOnly). This is the
        /// membership-vs-authority custody line: the UMK/IRK sync across the
        /// user's Apple-ID devices, the admin root does NOT — only devices
        /// explicitly promoted to admin hold it. Three slots mirror the UMK
        /// layout: the sealed seed, the ephemeral pubkey used to derive its wrap
        /// key, and the (non-secret) admin-root PUBLIC key for cheap presence +
        /// pubHex reads without a biometric. */
        static let adminRootWrapped      = "com.flagship.adminroot.wrapped"
        static let adminRootEphemeralPub = "com.flagship.adminroot.ephemeralpub"
        static let adminRootPub          = "com.flagship.adminroot.pub"
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
    /// kSecAttrSynchronizableAny is REQUIRED: our writes are `.cloudRoot`
    /// (kSecAttrSynchronizable=true) and a SecItemDelete WITHOUT this
    /// attribute matches ONLY non-synced items — so omitting it left the
    /// synced wrapped UMK behind on sign-out (and it came back from iCloud
    /// Keychain after a reinstall). Reads already use SynchronizableAny.
    fileprivate static func keychainDelete(account: String) {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
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
