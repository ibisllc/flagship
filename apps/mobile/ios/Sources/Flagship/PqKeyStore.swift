import Foundation
import CryptoKit
import LocalAuthentication
import Security
import FlagshipCore
import FlagshipAPI

/// The iPhone's ML-DSA-65 keys for its identities (architecture v2; docs/architecture-v2/
/// pq-suites.md §9). Each key is made here, fresh from the OS RNG, and never leaves the device.
///
/// - The `device` role on iOS 26+ (a Secure Enclave and an app-lock context at hand) gets a
///   `SecureEnclave.MLDSA65` key: non-exportable, used only with the context the user
///   authenticated, labelled "hardware PQ".
/// - Everything else (the account IRK, the admin root, and the device role on iOS 18–25 or when
///   no app-lock context exists) is a software ML-DSA-65 seed sealed to the Secure Enclave
///   wrapping key that also seals the UMK (Face ID or the passcode opens it), labelled
///   "PQ, hardware-wrapped". Sealing needs only that key's public half, so making a key never
///   prompts; the seed stays in memory for the rest of the unlocked session only.
///
/// Nothing here prompts: a key it cannot use without a prompt is reported as unavailable and
/// the caller defers to a later unlock.
public final class PqKeyStore: PqIdentityKeyStore, @unchecked Sendable {
    public static let shared = PqKeyStore()

    struct Record: Codable, Equatable {
        var role: String
        var subjectId: String
        var ed25519PubHex: String
        var mldsaPubHex: String
        var custody: PqCustody
        var sealedSeed: Data?
        var ephemeralPub: Data?
        var enclaveKey: Data?
        var status: PqBindingStatus?
        var createdAt: Int64
    }

    private let lock = NSLock()
    private var sessionSeeds: [String: Data] = [:]

    public init() {}

    private func slot(_ id: PqIdentity) -> String {
        "com.flagship.pq-identity.\(id.role.rawValue).\(id.subjectId).\(id.edPubHex.prefix(16))"
    }

    private func aad(_ id: PqIdentity) -> Data {
        Data(["flagship/pq-seed-wrap/v1", id.role.rawValue, id.subjectId, id.edPubHex].joined(separator: "|").utf8)
    }

    private func load(_ id: PqIdentity) -> Record? {
        guard let raw = Keystore.pqRecordRead(slot(id)), let r = try? JSONDecoder().decode(Record.self, from: raw),
              r.ed25519PubHex == id.edPubHex else { return nil }
        return r
    }

    private func save(_ r: Record, _ id: PqIdentity) {
        if let data = try? JSONEncoder().encode(r) { try? Keystore.pqRecordWrite(slot(id), data) }
    }

    /// The custody of this identity's key, when one exists.
    public func custody(for id: PqIdentity) -> PqCustody? { load(id)?.custody }

    public func key(for id: PqIdentity) async -> PqHeldKey? { keySync(id) }

    private func keySync(_ id: PqIdentity) -> PqHeldKey? {
        if let r = load(id) { return held(r, id) }
        let ctx = Keystore.sessionAuthContext
        if id.role == .device, let ctx, let r = makeEnclaveKey(id, ctx) {
            save(r, id)
            return held(r, id)
        }
        let seed = Data(PqHybrid.randomSeed())
        guard let pub = try? PqHybrid.mldsa65PublicKey(seed: Array(seed)),
              let sealed = try? Keystore.pqSealSeed(seed, aad: aad(id)) else { return nil }
        let r = Record(role: id.role.rawValue, subjectId: id.subjectId, ed25519PubHex: id.edPubHex,
                       mldsaPubHex: HexUtil.encode(Data(pub)), custody: .hardwareWrapped, sealedSeed: sealed.sealed,
                       ephemeralPub: sealed.ephemeralPub, enclaveKey: nil, status: .pending,
                       createdAt: Int64(Date().timeIntervalSince1970 * 1000))
        save(r, id)
        remember(seed, id)
        return held(r, id)
    }

    private func makeEnclaveKey(_ id: PqIdentity, _ ctx: LAContext) -> Record? {
        #if targetEnvironment(simulator)
        return nil
        #else
        guard #available(iOS 26.0, macOS 26.0, *), SecureEnclave.isAvailable,
              let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], nil),
              let key = try? SecureEnclave.MLDSA65.PrivateKey(accessControl: access, authenticationContext: ctx)
        else { return nil }
        return Record(role: id.role.rawValue, subjectId: id.subjectId, ed25519PubHex: id.edPubHex,
                      mldsaPubHex: HexUtil.encode(key.publicKey.rawRepresentation), custody: .hardware, sealedSeed: nil,
                      ephemeralPub: nil, enclaveKey: key.dataRepresentation, status: .pending,
                      createdAt: Int64(Date().timeIntervalSince1970 * 1000))
        #endif
    }

    private func held(_ r: Record, _ id: PqIdentity) -> PqHeldKey? {
        switch r.custody {
        case .hardware:
            #if targetEnvironment(simulator)
            return nil
            #else
            guard #available(iOS 26.0, macOS 26.0, *), let blob = r.enclaveKey, let ctx = Keystore.sessionAuthContext,
                  let key = try? SecureEnclave.MLDSA65.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
            else { return nil }
            return PqHeldKey(mldsaPubHex: r.mldsaPubHex, custody: .hardware) { m, c in
                [UInt8](try key.signature(for: Data(m), context: Data(c)))
            }
            #endif
        case .hardwareWrapped:
            guard let seed = seed(r, id) else { return nil }
            return PqHeldKey(mldsaPubHex: r.mldsaPubHex, custody: .hardwareWrapped) { m, c in
                try PqHybrid.mldsa65Sign(seed: Array(seed), message: m, context: c)
            }
        }
    }

    private func seed(_ r: Record, _ id: PqIdentity) -> Data? {
        lock.lock()
        let cached = sessionSeeds[slot(id)]
        lock.unlock()
        if let cached { return cached }
        guard let sealed = r.sealedSeed, let eph = r.ephemeralPub, let ctx = Keystore.sessionAuthContext,
              let seed = try? Keystore.pqOpenSeed(sealed, ephemeralPub: eph, aad: aad(id), context: ctx) else { return nil }
        remember(seed, id)
        return seed
    }

    private func remember(_ seed: Data, _ id: PqIdentity) {
        lock.lock(); defer { lock.unlock() }
        sessionSeeds[slot(id)] = seed
    }

    /// Drops the session's opened seeds (wired to the session key cache).
    public func clearSession() {
        lock.lock(); defer { lock.unlock() }
        sessionSeeds.removeAll()
    }

    public func status(for id: PqIdentity) -> PqBindingStatus? {
        if let r = load(id) { return r.status }
        return UserDefaults.standard.string(forKey: "flagship.pq.status.\(slot(id))").flatMap(PqBindingStatus.init(rawValue:))
    }

    public func setStatus(_ status: PqBindingStatus, for id: PqIdentity) {
        if var r = load(id) {
            r.status = status
            save(r, id)
        } else {
            UserDefaults.standard.set(status.rawValue, forKey: "flagship.pq.status.\(slot(id))")
        }
    }

    // MARK: Recovery

    /// A recovery restored this account's roots classically on this device. The IRK and admin
    /// root it holds at the next unlock are then never bound from here (a rotated root, a new
    /// key, is): a classical-only recovery must not install strict authority.
    public func markRecovered(username: String) {
        UserDefaults.standard.set(true, forKey: "flagship.pq.recovered.\(username.lowercased())")
    }

    /// Drops recovered roots from `ids`, pinning which keys they were on first sight.
    func withoutRecoveredRoots(_ ids: [PqIdentity], username: String) -> [PqIdentity] {
        let u = username.lowercased()
        let flagKey = "flagship.pq.recovered.\(u)", keysKey = "flagship.pq.recoveredKeys.\(u)"
        let d = UserDefaults.standard
        var keys = Set(d.stringArray(forKey: keysKey) ?? [])
        if d.bool(forKey: flagKey) {
            for id in ids where id.role == .accountIrk || id.role == .adminRoot { keys.insert(id.edPubHex) }
            d.set(Array(keys), forKey: keysKey)
            d.removeObject(forKey: flagKey)
        }
        return ids.filter { !(($0.role == .accountIrk || $0.role == .adminRoot) && keys.contains($0.edPubHex)) }
    }

    public func discard(_ id: PqIdentity) {
        Keystore.pqRecordDelete(slot(id))
        lock.lock(); defer { lock.unlock() }
        sessionSeeds[slot(id)] = nil
    }
}

/// Runs the identity bindings in the background (architecture v2, milestone 2): right after an
/// account is opened or joined, and at every unlock for accounts made before PQ keys. It only
/// ever uses keys already at hand and never prompts; whatever it cannot finish waits for the
/// next unlock.
public enum PqIdentityBindingService {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var _binder: PqIdentityBinder?
    private nonisolated(unsafe) static var _client: LivePqKeyBindingClient?

    /// Installed once at launch with the live `.com` client; unset (nothing runs) in the mock gym.
    public static func configure(client: LivePqKeyBindingClient) {
        lock.lock(); defer { lock.unlock() }
        _client = client
        _binder = PqIdentityBinder(store: PqKeyStore.shared, client: client)
    }

    private static var current: (PqIdentityBinder, LivePqKeyBindingClient)? {
        lock.lock(); defer { lock.unlock() }
        guard let b = _binder, let c = _client else { return nil }
        return (b, c)
    }

    /// The identities this session can bind without a prompt.
    public static func sessionIdentities(username: String, deviceId: String?) -> [PqIdentity] {
        let u = username.lowercased()
        var out: [PqIdentity] = []
        if let irk = Keystore.sessionIRKIfCached() { out.append(PqIdentity(role: .accountIrk, subjectId: u, edKey: irk)) }
        if let admin = Keystore.sessionAdminRoot() { out.append(PqIdentity(role: .adminRoot, subjectId: u, edKey: admin)) }
        if let deviceId, let dev = Keystore.sessionAccountDeviceKey(accountId: u, deviceId: deviceId) {
            out.append(PqIdentity(role: .device, subjectId: deviceId.lowercased(), edKey: dev))
        }
        return out
    }

    /// Binds `identities` in a detached task; returns at once.
    public static func bindInBackground(username: String, identities all: [PqIdentity]) {
        let identities = PqKeyStore.shared.withoutRecoveredRoots(all, username: username)
        guard let (binder, client) = current, !identities.isEmpty else { return }
        Task.detached(priority: .utility) {
            let remote = try? await client.fetch(username: username)
            await binder.run(username: username, identities: identities, remote: remote)
        }
    }

    /// The at-unlock upgrade: everything this unlocked session holds.
    public static func upgradeAtUnlock(username: String, deviceId: String?) {
        bindInBackground(username: username, identities: sessionIdentities(username: username, deviceId: deviceId))
    }
}
