import Foundation
import CryptoKit
import Flagship
import FlagshipAPI

/// Drives the phone's half of the boot-secret RELAY handshake
/// (docs/security-phone-as-unlock-endpoint.md):
///
///   1. fetchPending — builds an IRK-signed `DeviceEndpointClaim`
///      mailbox-auth credential, POSTs `/api/secret-requests`, and
///      RE-VERIFIES every returned request against the box's STK as
///      INDEPENDENTLY resolved from the directory (`/api/users/:u/pods`).
///      `.com` is not a trust anchor: a request whose STK mismatches the
///      directory (or whose signature fails under it) is dropped, NOT
///      surfaced for confirm.
///   2. confirm — for the verified request the user taps "yes, this is my
///      box" (the device-info backstop). By purpose:
///        - unlock-key:  GET the phone-sealed LUKS key, unseal it with the
///                       phone's existing Ed25519 key material, re-seal it
///                       for the box's STK (nonce/purpose-bound), POST it.
///        - entitlement: IRK-sign a root-only `RootEntitlement`, serialize
///                       it as the daemon's EntitlementBundle carrier, hex,
///                       POST it.
///
/// The crypto lives in the `Flagship` target; this coordinator only
/// orchestrates + decides. All freshness windows mirror the Worker's
/// ±5-min mailbox-auth window.
@MainActor
public final class SecretRequestCoordinator {

    public enum CoordinatorError: Error, LocalizedError, Equatable {
        case noSealedLuksKey
        case luksUnsealFailed
        case directoryMissingServer(String)
        case purposeUnsupported(String)

        public var errorDescription: String? {
            switch self {
            case .noSealedLuksKey:
                return "No sealed disk key is on file for this box yet."
            case .luksUnsealFailed:
                return "Couldn't unseal the disk key with this phone's keys."
            case .directoryMissingServer(let d):
                return "This box (\(d)) isn't registered to your account."
            case .purposeUnsupported(let p):
                return "Unsupported secret request type: \(p)."
            }
        }
    }

    /// A request that PASSED directory re-verification, ready to show the
    /// user the device-info confirm sheet. The raw `PendingSecretRequest`
    /// + the resolved STK are retained so confirm doesn't re-resolve.
    public struct VerifiedRequest: Equatable, Sendable, Identifiable {
        public let pending: PendingSecretRequest
        /// The STK as resolved from the DIRECTORY (not the mailbox echo).
        public let directoryStkPubHex: String
        public var id: String { pending.id }
        public var serverDomain: String { pending.serverDomain }
        public var purpose: SecretPurpose? { SecretPurpose(rawValue: pending.purpose) }
        public var deviceInfo: DeviceInfoHint? { pending.deviceInfo }
    }

    private let mailbox: SecretMailboxClient
    private let username: String
    /// Resolves the user IRK private key (biometric-gated). Injectable so
    /// tests don't touch the Keychain / Secure Enclave.
    private let irkProvider: () async throws -> Curve25519.Signing.PrivateKey
    /// Resolves the phone's candidate Ed25519 unseal SEEDS for a given
    /// serverDomain, in priority order (the per-server BAK first, then the
    /// IRK). Whichever key the installer sealed the LUKS blob against, the
    /// phone opens it. Injectable for tests.
    private let unsealSeedProvider: (String) async throws -> [Data]
    private let now: () -> Int64
    private let nonceGen: () -> Data

    public init(
        mailbox: SecretMailboxClient,
        username: String,
        irkProvider: @escaping () async throws -> Curve25519.Signing.PrivateKey,
        unsealSeedProvider: @escaping (String) async throws -> [Data],
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        nonceGen: @escaping () -> Data = { SecretRequestCoordinator.randomNonce() }
    ) {
        self.mailbox = mailbox
        self.username = username
        self.irkProvider = irkProvider
        self.unsealSeedProvider = unsealSeedProvider
        self.now = now
        self.nonceGen = nonceGen
    }

    public nonisolated static func randomNonce() -> Data {
        var b = Data(count: 32)
        _ = b.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        return b
    }

    // MARK: - 1. Fetch + re-verify

    /// Build the mailbox auth, fetch the account's pending requests, and
    /// keep only those that re-verify against the directory STK. A request
    /// `.com` returns whose STK isn't directory-bound (or whose signature
    /// fails under that STK) is SILENTLY dropped — never offered for
    /// confirm.
    public func fetchVerifiedRequests() async throws -> [VerifiedRequest] {
        let irk = try await irkProvider()
        let auth = try buildMailboxAuth(irk: irk)
        let pendingResp = try await mailbox.fetchPendingRequests(auth: auth)
        let directory = try await mailbox.fetchPods(username: username)

        var verified: [VerifiedRequest] = []
        for pending in pendingResp.requests {
            guard let stkHex = directory.identityPubKey(forServerDomain: pending.serverDomain),
                  let stkPubData = HexUtil.decode(stkHex), stkPubData.count == 32,
                  let stkPub = try? Curve25519.Signing.PublicKey(rawRepresentation: stkPubData)
            else {
                // No directory entry → `.com` cannot vouch for this box.
                continue
            }
            // The mailbox echo MUST equal the directory STK — a relay can't
            // splice in a different stkPub.
            guard pending.stkPub.lowercased() == stkHex.lowercased() else { continue }
            guard let purpose = SecretPurpose(rawValue: pending.purpose),
                  let nonce = HexUtil.decode(pending.requestNonceHex),
                  let sig = HexUtil.decode(pending.requestSignature)
            else { continue }
            let request = SecretRequest(
                serverDomain: pending.serverDomain,
                stkPub: stkPubData,
                purpose: purpose,
                nonce: nonce,
                issuedAt: pending.issuedAt
            )
            // RE-VERIFY the box's request against the DIRECTORY STK.
            guard SecretRequest.verify(request, signature: sig, stkPub: stkPub) else { continue }
            verified.append(VerifiedRequest(pending: pending, directoryStkPubHex: stkHex))
        }
        return verified
    }

    // MARK: - 2. Confirm (one tap = the human backstop)

    /// The user has confirmed "yes, this is my box". Perform the crypto +
    /// post the reply. When `depositAutoLease` is true (the server's chosen
    /// boot-unlock mode is "auto"), ALSO deposit a box-sealed lease so future
    /// boots self-unlock without the phone — returns the lease id (store it
    /// per-server for the kill switch). Otherwise returns nil.
    @discardableResult
    public func confirmAndRespond(
        _ verified: VerifiedRequest,
        depositAutoLease: Bool = false
    ) async throws -> String? {
        guard let purpose = verified.purpose else {
            throw CoordinatorError.purposeUnsupported(verified.pending.purpose)
        }
        guard let stkPubData = HexUtil.decode(verified.directoryStkPubHex), stkPubData.count == 32,
              let nonce = HexUtil.decode(verified.pending.requestNonceHex)
        else {
            throw CoordinatorError.directoryMissingServer(verified.serverDomain)
        }
        let request = SecretRequest(
            serverDomain: verified.serverDomain,
            stkPub: stkPubData,
            purpose: purpose,
            nonce: nonce,
            issuedAt: verified.pending.issuedAt
        )
        let irk = try await irkProvider()
        let auth = try buildMailboxAuth(irk: irk)

        let sealedHex: String
        var unlockKey: Data?
        switch purpose {
        case .unlockKey:
            let reply = try await buildUnlockReply(request: request)
            sealedHex = reply.sealedHex
            unlockKey = reply.luksKey
        case .entitlement:
            sealedHex = try buildEntitlementReply(request: request, irk: irk)
        }

        let body = SecretResponseBody(
            serverDomain: request.serverDomain,
            requestNonceHex: HexUtil.encode(nonce),
            purpose: purpose.rawValue,
            sealed: sealedHex,
            issuedAt: now()
        )
        try await mailbox.postResponse(auth: auth, response: body)

        // "auto" mode: deposit a box-sealed lease so the box self-unlocks on
        // future reboots (the user's IRK authorizes it here — I2). Only for
        // unlock-key; the key is the one we just recovered, never `.com`-visible.
        if depositAutoLease, purpose == .unlockKey, let key = unlockKey {
            return try await depositAutoUnlockLease(request: request, luksKey: key, irk: irk)
        }
        return nil
    }

    /// Kill switch — revoke a server's auto-unlock lease. The box can no
    /// longer self-unlock and falls back to phone-gated approval (a downgrade,
    /// not a brick). `leaseId` is the one returned by confirmAndRespond at
    /// deposit (stored per-server by the caller).
    public func revokeAutoUnlockLease(serverDomain: String, leaseId: String) async throws {
        let irk = try await irkProvider()
        let issuedAt = now()
        let rev = LeaseRevocation(serverDomain: serverDomain, leaseId: leaseId, issuedAt: issuedAt)
        let sig = try rev.sign(with: irk)
        try await mailbox.revokeBoxSealedLease(
            request: LeaseRevokeWire(serverDomain: serverDomain, leaseId: leaseId, issuedAt: issuedAt),
            signatureHex: HexUtil.encode(sig)
        )
    }

    /// Deposit a long-lived box-sealed lease (the LUKS key sealed for the box
    /// STK). Returns the lease id. Private — only reachable right after a
    /// user-confirmed unlock approval, when we hold the recovered key.
    private func depositAutoUnlockLease(
        request: SecretRequest,
        luksKey: Data,
        irk: Curve25519.Signing.PrivateKey
    ) async throws -> String {
        let issuedAt = now()
        let leaseId = AutoUnlockLeaseV2.randomLeaseId()
        let expiresAt = issuedAt + 365 * 24 * 60 * 60 * 1000  // ~1 year; renewed on each approve
        let lease = try AutoUnlockLeaseV2.build(
            serverDomain: request.serverDomain,
            stkPub: request.stkPub,
            leaseId: leaseId,
            luksKey: luksKey,
            issuedAt: issuedAt,
            expiresAt: expiresAt
        )
        let sig = try lease.sign(with: irk)
        try await mailbox.depositBoxSealedLease(
            lease: BoxSealedLeaseWire(
                serverDomain: lease.serverDomain,
                stkPub: HexUtil.encode(lease.stkPub),
                leaseId: lease.leaseId,
                sealedKey: HexUtil.encode(lease.sealedKey),
                issuedAt: lease.issuedAt,
                expiresAt: lease.expiresAt,
                maxUses: lease.maxUses
            ),
            signatureHex: HexUtil.encode(sig)
        )
        return leaseId
    }

    // MARK: - unlock-key

    /// Fetch the phone-sealed LUKS key, unseal it with the phone's existing
    /// Ed25519 key material (the installer sealed it against one of these),
    /// then re-seal it FOR the box's STK bound to (nonce, purpose).
    private func buildUnlockReply(request: SecretRequest) async throws -> (sealedHex: String, luksKey: Data) {
        let sealedLuks: SealedLuksKeyResponse
        do {
            sealedLuks = try await mailbox.fetchSealedLuksKey(serverDomain: request.serverDomain)
        } catch ScreensClientError.http(let status, _) where status == 404 {
            throw CoordinatorError.noSealedLuksKey
        }
        guard let sealedBlob = HexUtil.decode(sealedLuks.sealedKey), !sealedBlob.isEmpty else {
            throw CoordinatorError.noSealedLuksKey
        }

        // Try each candidate phone key seed until one opens the blob —
        // whichever Ed25519 key the installer sealed against.
        let candidates = try await unsealSeedProvider(request.serverDomain)
        var luksKey: Data?
        for seed in candidates {
            if let opened = try? SecretSeal.openWithEd25519Seed(blob: sealedBlob, recipientEd25519Seed: seed) {
                luksKey = opened
                break
            }
        }
        guard let key = luksKey else { throw CoordinatorError.luksUnsealFailed }

        // Re-seal FOR the box's STK, nonce/purpose-bound. Also hand back the
        // recovered key so an "auto" approval can deposit a box-sealed lease.
        let resp = try SealedSecretResponse.build(secret: key, request: request, now: now)
        return (HexUtil.encode(resp.sealed), key)
    }

    // MARK: - entitlement

    /// IRK-sign a root-only RootEntitlement binding (username, podPubKey =
    /// box STK, podCanonical = serverDomain) and serialize it as the
    /// daemon's EntitlementBundle on-disk carrier, hex-encoded.
    private func buildEntitlementReply(
        request: SecretRequest,
        irk: Curve25519.Signing.PrivateKey
    ) throws -> String {
        let cert = RootEntitlement(
            username: username,
            podPubKey: request.stkPub,
            podCanonical: request.serverDomain,
            issuedAt: now()
        )
        let sig = try cert.sign(with: irk)
        let carrier = EntitlementBundleCarrier.serialize(rootEntitlement: cert, rootEntitlementSig: sig)
        return HexUtil.encode(carrier)
    }

    // MARK: - mailbox auth

    private func buildMailboxAuth(irk: Curve25519.Signing.PrivateKey) throws -> MailboxAuthEnvelope {
        let issuedAt = now()
        let claim = DeviceEndpointClaim(
            username: username,
            // There is no hosted endpoint; "device" is a constant label
            // (the Worker only checks phoneIrkPub == account IRK).
            endpointLabel: "device",
            phoneIrkPub: irk.publicKey.rawRepresentation,
            issuedAt: issuedAt,
            // Short-lived — the claim only needs to live for one fetch/post.
            expiresAt: issuedAt + 120_000,
            nonce: nonceGen()
        )
        let sig = try claim.sign(with: irk)
        return MailboxAuthEnvelope(
            auth: .init(
                username: claim.username,
                endpointLabel: claim.endpointLabel,
                phoneIrkPub: HexUtil.encode(claim.phoneIrkPub),
                issuedAt: claim.issuedAt,
                expiresAt: claim.expiresAt,
                nonce: HexUtil.encode(claim.nonce)
            ),
            authSignature: HexUtil.encode(sig)
        )
    }
}
