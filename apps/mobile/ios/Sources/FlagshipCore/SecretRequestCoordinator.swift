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
    /// post the reply. Returns when `.com` has accepted the write-once
    /// reply (the box then picks it up on its poll).
    public func confirmAndRespond(_ verified: VerifiedRequest) async throws {
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
        switch purpose {
        case .unlockKey:
            sealedHex = try await buildUnlockReply(request: request)
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
    }

    // MARK: - unlock-key

    /// Fetch the phone-sealed LUKS key, unseal it with the phone's existing
    /// Ed25519 key material (the installer sealed it against one of these),
    /// then re-seal it FOR the box's STK bound to (nonce, purpose).
    private func buildUnlockReply(request: SecretRequest) async throws -> String {
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

        // Re-seal FOR the box's STK, nonce/purpose-bound.
        let resp = try SealedSecretResponse.build(secret: key, request: request, now: now)
        return HexUtil.encode(resp.sealed)
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
