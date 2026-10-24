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

    /// Every server that opted in, ended or not (a renewal puts their copies back).
    public func optedIn() -> [String] { all.keys.sorted() }

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

/// The one source of the box key the watch path trusts for a server: trust on first use. A real box's
/// key is random (`install-helper gen-identity`), so nothing on the phone can derive it; the key `.com`'s
/// directory lists when the owner first turns a server's watch start-up on is recorded here and never
/// replaced silently. A different key later is refused until the owner turns the switch off (which forgets
/// it) and on again. Interim, pending the owner's decision on where server keys are pinned.
public struct WatchBootStkPins {
    private static let key = "flagship.watchBootKeys.pinnedStk"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private var all: [String: String] {
        get { defaults.dictionary(forKey: Self.key) as? [String: String] ?? [:] }
        nonmutating set { defaults.set(newValue, forKey: Self.key) }
    }

    public func pinnedStk(_ serverDomain: String) -> Data? {
        all[serverDomain.lowercased()].flatMap(HexUtil.decode).flatMap { $0.count == 32 ? $0 : nil }
    }

    /// Record the first key seen for the server. False when a different key is already recorded.
    @discardableResult
    public func record(_ stk: Data, for serverDomain: String) -> Bool {
        guard stk.count == 32 else { return false }
        if let pinned = pinnedStk(serverDomain) { return pinned == stk }
        var m = all
        m[serverDomain.lowercased()] = HexUtil.encode(stk)
        all = m
        return true
    }

    /// The owner's explicit re-trust: the next first use records whatever key the server then has.
    public func forget(_ serverDomain: String) {
        var m = all
        m[serverDomain.lowercased()] = nil
        all = m
    }
}

/// Owner side of option (a): put a copy of one server's disk key on the boot worker, sealed to the watch's
/// boot-only key and attested by the account key, or take every copy for the server away.
@MainActor
public struct WatchBootKeyEnroller {
    public enum Failure: Error, Equatable, LocalizedError {
        case notEnrolled
        case delegateExpired
        /// The directory lists a different key than the one recorded for this server.
        case keyChanged
        case notListed

        public var errorDescription: String? {
            switch self {
            case .notEnrolled: return String(localized: "Turn on Approve from watch in Account security first.")
            case .delegateExpired: return String(localized: "Your watch's approval has ended. Turn Approve from watch off and on again in Account security.")
            case .keyChanged: return String(localized: "This server's key changed since you turned this on. If you reinstalled it, turn this off and on again to trust the new key.")
            case .notListed: return String(localized: "This server isn't registered to your account.")
            }
        }
    }

    let mailbox: SecretMailboxClient
    let username: String
    let pins: WatchBootStkPins
    let irk: () async throws -> Curve25519.Signing.PrivateKey
    let unsealSeeds: (String) async throws -> [Data]
    let delegatePub: () -> Data?
    let bootPub: () throws -> Data
    let now: () -> Int64
    let nonceGen: () -> Data

    public init(
        mailbox: SecretMailboxClient,
        username: String,
        pins: WatchBootStkPins = WatchBootStkPins(),
        irk: @escaping () async throws -> Curve25519.Signing.PrivateKey,
        unsealSeeds: @escaping (String) async throws -> [Data],
        delegatePub: @escaping () -> Data?,
        bootPub: @escaping () throws -> Data,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        nonceGen: @escaping () -> Data = { BootAuth.randomNonce() }
    ) {
        self.mailbox = mailbox
        self.username = username
        self.pins = pins
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
        // Trust on first use: the key listed now is recorded, and a later different one is refused.
        let directory = try await mailbox.fetchPods(username: username)
        guard let listedHex = directory.identityPubKey(forServerDomain: serverDomain),
              let listed = HexUtil.decode(listedHex), listed.count == 32 else { throw Failure.notListed }
        guard pins.record(listed, for: serverDomain) else { throw Failure.keyChanged }
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
/// it to the box key this phone pinned for the server (never one `.com` names) and post it signed by the
/// watch delegate. Needs no UMK and starts no Face ID. A locked server (SEC-LOCK-001) gives a delegate
/// nothing: it is started from the phone with the account key.
@MainActor
public struct WatchBootApprover {
    public enum Outcome: Equatable, Sendable {
        case approved
        /// The owner locked the server: only the phone, with the account key, can start it.
        case locked
        /// No copy for this watch (not turned on for this server, or it ended), or nothing this phone pinned.
        case noCopy
        /// The server isn't waiting any more, or the request ended.
        case gone
        /// `.com` names a box key other than the one this phone pinned: nothing was sealed.
        case keyMismatch
        /// The request isn't signed by the pinned box key: nothing was sealed.
        case badSignature
        case failed(String)
    }

    public static let keyMismatchCode = "watch-boot-stk-mismatch"
    public static let badSignatureCode = "watch-boot-request-signature"

    let mailbox: SecretMailboxClient
    let username: String
    let delegateKey: () -> Curve25519.Signing.PrivateKey?
    let bootKey: () -> Curve25519.KeyAgreement.PrivateKey?
    /// The box key this phone pinned for a server when it made or paired it (what the account-key path trusts).
    let pinnedStk: (String) -> Data?
    let now: () -> Int64
    let nonceGen: () -> Data

    public init(
        mailbox: SecretMailboxClient,
        username: String,
        delegateKey: @escaping () -> Curve25519.Signing.PrivateKey?,
        bootKey: @escaping () -> Curve25519.KeyAgreement.PrivateKey?,
        pinnedStk: @escaping (String) -> Data?,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        nonceGen: @escaping () -> Data = { BootAuth.randomNonce() }
    ) {
        self.mailbox = mailbox
        self.username = username
        self.delegateKey = delegateKey
        self.bootKey = bootKey
        self.pinnedStk = pinnedStk
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
        // Without a pinned key there is nothing this phone trusts to seal to: the account-key path decides.
        guard let stk = pinnedStk(domain), stk.count == 32,
              let stkPub = try? Curve25519.Signing.PublicKey(rawRepresentation: stk) else { return .noCopy }
        do {
            // The box's own signed request, read with the account read token (no IRK): `.com` only relays it.
            let requests: [SignedSecretRequestWire]
            do {
                requests = try await mailbox.fetchSignedSecretRequests(username: username)
            } catch {
                return .noCopy
            }
            let nonceHex = HexUtil.encode(nonce)
            guard let row = requests.first(where: {
                $0.serverDomain.lowercased() == domain && $0.requestNonceHex.lowercased() == nonceHex && $0.purpose == SecretPurpose.unlockKey.rawValue
            }) else { return .gone }
            guard row.expiresAt > now() else { return .gone }
            guard HexUtil.decode(row.stkPub) == stk else {
                DiagnosticsLog.shared.record(code: Self.keyMismatchCode, host: domain)
                return .keyMismatch
            }
            let request = SecretRequest(serverDomain: row.serverDomain, stkPub: stk, purpose: .unlockKey, nonce: nonce, issuedAt: row.issuedAt)
            guard let sig = HexUtil.decode(row.requestSignature), SecretRequest.verify(request, signature: sig, stkPub: stkPub) else {
                DiagnosticsLog.shared.record(code: Self.badSignatureCode, host: domain)
                return .badSignature
            }

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

            let sealed = try SealedSecretResponse.build(secret: diskKey, request: request, now: now)
            let body = SecretResponseBody(serverDomain: row.serverDomain, requestNonceHex: nonceHex,
                                          purpose: SecretPurpose.unlockKey.rawValue, sealed: HexUtil.encode(sealed.sealed),
                                          issuedAt: now())
            let postAuth = try BootAuth.delegateHeader(serverDomain: row.serverDomain, method: "POST", path: "/api/boot/response",
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

/// Keeps Approve from watch alive without asking: while the app is unlocked and the 7-day delegate has
/// under two days left, mint the next one with a key this session already holds (never a prompt) and put
/// each server's watch copy back with the new end.
@MainActor
public struct WatchDelegateRenewer {
    public static let renewWithinMs: Int64 = 2 * 86_400_000
    public static let ttlMs: Int64 = 7 * 86_400_000

    public enum Result: Equatable, Sendable {
        case notDue
        /// Due, but no key could sign without a prompt (or the mint failed): tried again next time.
        case skipped
        case renewed(expiresAt: Int64)
    }

    let server: FlagshipServerClient
    let username: String
    let store: WatchBootKeyStore
    let silentKey: () -> Curve25519.Signing.PrivateKey?
    let delegateKey: () -> Curve25519.Signing.PrivateKey?
    let saveGrantId: (String) -> Void
    let redeposit: (_ serverDomain: String, _ delegateExpiresAt: Int64) async throws -> Int64
    let now: () -> Int64
    let grantIdGen: () -> String

    public init(server: FlagshipServerClient, username: String, store: WatchBootKeyStore = WatchBootKeyStore(),
                silentKey: @escaping () -> Curve25519.Signing.PrivateKey?,
                delegateKey: @escaping () -> Curve25519.Signing.PrivateKey?,
                saveGrantId: @escaping (String) -> Void,
                redeposit: @escaping (_ serverDomain: String, _ delegateExpiresAt: Int64) async throws -> Int64,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                grantIdGen: @escaping () -> String = { UUID().uuidString.lowercased() }) {
        self.server = server
        self.username = username
        self.store = store
        self.silentKey = silentKey
        self.delegateKey = delegateKey
        self.saveGrantId = saveGrantId
        self.redeposit = redeposit
        self.now = now
        self.grantIdGen = grantIdGen
    }

    public func renewIfDue() async -> Result {
        guard let delegate = delegateKey(), let ends = store.delegateExpiresAt else { return .notDue }
        let t = now()
        guard ends - t < Self.renewWithinMs else { return .notDue }
        guard let key = silentKey() else { return .skipped }
        let env = WatchDelegateKeyEnvelope(
            grantId: grantIdGen(), username: username,
            delegatePubKeyHex: HexUtil.encode(delegate.publicKey.rawRepresentation),
            scopes: [WatchDelegateKeyEnvelope.bootApprovalScope], issuedAt: t, expiresAt: t + Self.ttlMs)
        let minted: WatchDelegateMintResponse
        do {
            let sig = try env.sign(with: key)
            minted = try await server.mintWatchDelegate(username: username, body: WatchDelegateMintRequest(
                grant: .init(grantId: env.grantId, username: username, delegatePubKey: env.delegatePubKeyHex,
                             scopes: env.scopes, issuedAt: env.issuedAt, expiresAt: env.expiresAt),
                signature: HexUtil.encode(sig)))
        } catch {
            return .skipped
        }
        saveGrantId(minted.grantId)
        store.delegateExpiresAt = minted.expiresAt
        for domain in store.optedIn() {
            if let copyEnds = try? await redeposit(domain, minted.expiresAt) { store.set(copyEnds, for: domain) }
        }
        return .renewed(expiresAt: minted.expiresAt)
    }
}
