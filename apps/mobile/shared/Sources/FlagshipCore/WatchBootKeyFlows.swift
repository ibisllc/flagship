import Foundation
import CryptoKit
import FlagshipAPI

/// The servers whose start-up this device's watch may approve with the phone locked, and until when.
/// Not secret (the copies themselves live on the boot worker, sealed to the watch's boot-only key).
public struct WatchBootKeyStore {
    private static let key = "flagship.watchBootKeys.expiresAt"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private var all: [String: Double] {
        get { defaults.dictionary(forKey: Self.key) as? [String: Double] ?? [:] }
        nonmutating set { defaults.set(newValue, forKey: Self.key) }
    }

    /// When this server's copy ends, or nil when there is none (or it has ended).
    public func expiresAt(for serverDomain: String, now: Int64) -> Int64? {
        guard let v = all[serverDomain.lowercased()] else { return nil }
        let at = Int64(v)
        return at > now ? at : nil
    }

    public func set(_ expiresAt: Int64?, for serverDomain: String) {
        var m = all
        m[serverDomain.lowercased()] = expiresAt.map(Double.init)
        all = m
    }

    public func servers(now: Int64) -> [String] {
        all.filter { Int64($0.value) > now }.map(\.key).sorted()
    }

    private static let delegateKey = "flagship.watchBootKeys.delegateExpiresAt"

    /// When this device's watch delegate ends; a copy may not outlast it.
    public var delegateExpiresAt: Int64? {
        get { (defaults.object(forKey: Self.delegateKey) as? Double).map { Int64($0) } }
        nonmutating set {
            if let v = newValue { defaults.set(Double(v), forKey: Self.delegateKey) } else { defaults.removeObject(forKey: Self.delegateKey) }
        }
    }

    public func clear() {
        defaults.removeObject(forKey: Self.key)
        defaults.removeObject(forKey: Self.delegateKey)
    }
}

/// Owner side of option (a): put a copy of one server's disk key on the boot worker, sealed to the watch's
/// boot-only key and attested by the account key, or take every copy for the server away.
@MainActor
public struct WatchBootKeyEnroller {
    public enum Failure: Error, Equatable, LocalizedError {
        case notEnrolled
        case delegateExpired

        public var errorDescription: String? {
            switch self {
            case .notEnrolled: return String(localized: "Turn on Approve from watch in Account security first.")
            case .delegateExpired: return String(localized: "Your watch's approval has ended. Turn Approve from watch off and on again in Account security.")
            }
        }
    }

    let mailbox: SecretMailboxClient
    let irk: () async throws -> Curve25519.Signing.PrivateKey
    let unsealSeeds: (String) async throws -> [Data]
    let delegatePub: () -> Data?
    let bootPub: () throws -> Data
    let now: () -> Int64
    let nonceGen: () -> Data

    public init(
        mailbox: SecretMailboxClient,
        irk: @escaping () async throws -> Curve25519.Signing.PrivateKey,
        unsealSeeds: @escaping (String) async throws -> [Data],
        delegatePub: @escaping () -> Data?,
        bootPub: @escaping () throws -> Data,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        nonceGen: @escaping () -> Data = { BootAuth.randomNonce() }
    ) {
        self.mailbox = mailbox
        self.irk = irk
        self.unsealSeeds = unsealSeeds
        self.delegatePub = delegatePub
        self.bootPub = bootPub
        self.now = now
        self.nonceGen = nonceGen
    }

    /// Deposit the copy. It lasts as long as the watch delegate does, and never more than seven days.
    /// Returns when it ends.
    @discardableResult
    public func turnOn(serverDomain: String, delegateExpiresAt: Int64) async throws -> Int64 {
        guard let delegate = delegatePub() else { throw Failure.notEnrolled }
        let issuedAt = now()
        let expiresAt = min(delegateExpiresAt, issuedAt + WatchBootDelegate.maxMs)
        guard expiresAt > issuedAt else { throw Failure.delegateExpired }
        let decrypt = try bootPub()
        let sealed: SealedLuksKeyResponse
        do {
            sealed = try await mailbox.fetchSealedLuksKey(serverDomain: serverDomain)
        } catch ScreensClientError.http(let status, _) where status == 404 {
            throw SecretRequestCoordinator.CoordinatorError.noSealedLuksKey
        }
        guard let blob = HexUtil.decode(sealed.sealedKey), !blob.isEmpty else {
            throw SecretRequestCoordinator.CoordinatorError.noSealedLuksKey
        }
        var diskKey: Data?
        for seed in try await unsealSeeds(serverDomain) {
            if let k = try? SecretSeal.openWithEd25519Seed(blob: blob, recipientEd25519Seed: seed) { diskKey = k; break }
        }
        guard let diskKey else { throw SecretRequestCoordinator.CoordinatorError.luksUnsealFailed }
        // The worker checks the attestation under the key that signs the owner header: the IRK.
        let irk = try await irk()
        let deposit = try WatchBootDeposit.build(
            serverDomain: serverDomain, diskKey: diskKey, delegatePub: delegate, decryptPub: decrypt,
            issuedAt: issuedAt, expiresAt: expiresAt, sign: { try irk.signature(for: $0) })
        let a = deposit.attestation
        let wire = WatchBootDepositWire(
            serverDomain: a.serverDomain, delegatePubHex: a.delegatePubHex, decryptPubHex: a.decryptPubHex,
            keySha256Hex: a.keySha256Hex, issuedAt: a.issuedAt, expiresAt: a.expiresAt,
            sealedKeyHex: deposit.sealedKeyHex, signatureHex: deposit.signatureHex)
        let auth = try BootAuth.ownerHeader(serverDomain: a.serverDomain, method: "PUT", path: "/api/boot/watch-key",
                                            irk: irk, now: now(), nonce: nonceGen())
        try await mailbox.depositWatchBootKey(wire, bootAuth: auth)
        return expiresAt
    }

    public func turnOff(serverDomain: String) async throws {
        let domain = serverDomain.lowercased()
        let irk = try await irk()
        let auth = try BootAuth.ownerHeader(serverDomain: domain, method: "DELETE", path: "/api/boot/watch-key/\(domain)",
                                            irk: irk, now: now(), nonce: nonceGen())
        try await mailbox.revokeWatchBootKeys(serverDomain: domain, bootAuth: auth)
    }
}

/// Watch side of option (a), run on the iPhone while the account key is not open (the app is locked or in
/// the background): fetch this watch's copy of the server's disk key, open it with the boot-only key, seal
/// it to the box's directory key for this request and post it signed by the watch delegate. Needs no UMK
/// and starts no Face ID. A locked server (SEC-LOCK-001) gives a delegate nothing: it is started from the
/// phone with the account key.
@MainActor
public struct WatchBootApprover {
    public enum Outcome: Equatable, Sendable {
        case approved
        /// The owner locked the server: only the phone, with the account key, can start it.
        case locked
        /// No copy for this watch (not turned on for this server, or it ended).
        case noCopy
        /// The server isn't waiting any more, or isn't in the directory.
        case gone
        case failed(String)
    }

    let mailbox: SecretMailboxClient
    let username: String
    let delegateKey: () -> Curve25519.Signing.PrivateKey?
    let bootKey: () -> Curve25519.KeyAgreement.PrivateKey?
    let now: () -> Int64
    let nonceGen: () -> Data

    public init(
        mailbox: SecretMailboxClient,
        username: String,
        delegateKey: @escaping () -> Curve25519.Signing.PrivateKey?,
        bootKey: @escaping () -> Curve25519.KeyAgreement.PrivateKey?,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        nonceGen: @escaping () -> Data = { BootAuth.randomNonce() }
    ) {
        self.mailbox = mailbox
        self.username = username
        self.delegateKey = delegateKey
        self.bootKey = bootKey
        self.now = now
        self.nonceGen = nonceGen
    }

    /// `<serverDomain>#<nonceHex>`, the id the inbox and the Approvals screen both use.
    public static func parse(requestId: String) -> (serverDomain: String, nonce: Data)? {
        let parts = requestId.split(separator: "#", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, let nonce = HexUtil.decode(String(parts[1])), nonce.count == 32 else { return nil }
        return (String(parts[0]).lowercased(), nonce)
    }

    public func approve(requestId: String) async -> Outcome {
        guard let (domain, nonce) = Self.parse(requestId: requestId) else { return .gone }
        guard let delegate = delegateKey(), let boot = bootKey() else { return .noCopy }
        do {
            let getAuth = try BootAuth.delegateHeader(serverDomain: domain, method: "GET", path: "/api/boot/watch-key/\(domain)",
                                                      delegateKey: delegate, now: now(), nonce: nonceGen())
            let wire: WatchBootDepositWire
            do {
                wire = try await mailbox.fetchWatchBootKey(serverDomain: domain, bootAuth: getAuth)
            } catch ScreensClientError.http(let status, _) where status == 423 {
                return .locked
            } catch ScreensClientError.http(let status, _) where status == 404 || status == 403 {
                return .noCopy
            }
            let delegateHex = HexUtil.encode(delegate.publicKey.rawRepresentation)
            let bootHex = HexUtil.encode(boot.publicKey.rawRepresentation)
            guard wire.delegatePubHex.lowercased() == delegateHex, wire.decryptPubHex.lowercased() == bootHex,
                  wire.serverDomain.lowercased() == domain, wire.expiresAt > now() else { return .noCopy }
            let deposit = WatchBootDeposit(
                attestation: WatchBootDelegate(serverDomain: wire.serverDomain, delegatePubHex: wire.delegatePubHex,
                                               decryptPubHex: wire.decryptPubHex, keySha256Hex: wire.keySha256Hex,
                                               issuedAt: wire.issuedAt, expiresAt: wire.expiresAt),
                sealedKeyHex: wire.sealedKeyHex, signatureHex: wire.signatureHex)
            let diskKey = try deposit.openKey(decryptPriv: boot.rawRepresentation)

            // The box's key comes from the directory, never from the request, so only that box can open the answer.
            let directory = try await mailbox.fetchPods(username: username)
            guard let stkHex = directory.identityPubKey(forServerDomain: domain),
                  let stk = HexUtil.decode(stkHex), stk.count == 32 else { return .gone }
            let serverDomain = directory.pods.first { $0.serverDomain.lowercased() == domain }?.serverDomain ?? domain
            let request = SecretRequest(serverDomain: serverDomain, stkPub: stk, purpose: .unlockKey, nonce: nonce, issuedAt: 0)
            let sealed = try SealedSecretResponse.build(secret: diskKey, request: request, now: now)
            let body = SecretResponseBody(serverDomain: serverDomain, requestNonceHex: HexUtil.encode(nonce),
                                          purpose: SecretPurpose.unlockKey.rawValue, sealed: HexUtil.encode(sealed.sealed),
                                          issuedAt: now())
            let postAuth = try BootAuth.delegateHeader(serverDomain: serverDomain, method: "POST", path: "/api/boot/response",
                                                       delegateKey: delegate, now: now(), nonce: nonceGen())
            do {
                try await mailbox.postResponse(response: body, bootAuth: postAuth)
            } catch ScreensClientError.http(let status, _) where status == 423 {
                return .locked
            } catch ScreensClientError.http(let status, _) where status == 404 || status == 409 {
                return .gone
            }
            return .approved
        } catch {
            return .failed(String(localized: "Approval failed: \(error.localizedDescription)"))
        }
    }
}
