import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// #28 seal-to-box — drives the "Grant cert-minting autonomy to this box"
/// action on the server-detail screen.
///
/// The ACME account key is the authority to mint a user's
/// `[<user>, *.<user>]` TLS cert. By default it lives ONLY on the admin
/// device and the box stays "managed" (it asks for a fresh cert each
/// renewal). This action opts a SPECIFIC box into autonomy: it seals the
/// account key to that box's STK and IRK-signs the grant, so the box can
/// re-issue its own cert offline indefinitely.
///
/// Flow (mirrors the TS daemon/control-plane mint side):
///   1. Re-resolve the addressed box's STK from the pods directory
///      (`GET /api/users/:u/pods`) — NOT from any caller-supplied echo,
///      so a lying relay can't get us to seal for a box it controls.
///   2. Build + seal + IRK-sign the grant for that STK via
///      `AcmeAccountKeyGrantProducer` (re-hydrating the local #28 scalar).
///   3. POST it to the domain-scoped delivery endpoint
///      (`POST /api/server/<serverDomain>/acme-account-key`).
///
/// `accountKeyScalarProvider` + `signer` are injected (defaulting to
/// `Keystore`) so the orchestration is testable without the Secure
/// Enclave — same shape as `RevokeServerViewModel`.
@Observable
@MainActor
public final class CertAutonomyGrantViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case resolving   // fetching the pods directory for the box STK
        case signing     // sealing + IRK-signing the grant
        case posting     // POSTing the domain-scoped delivery
        case completed(accountKeyId: String)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let server: FlagshipServerClient
    private let mailbox: SecretMailboxClient
    private let serverDomain: String
    private let username: @MainActor () -> String?
    /// Pluggable for tests: the raw 32-byte P-256 ACME account scalar held
    /// by this (admin) device, or nil if this device never minted one.
    /// Default reads `Keystore.acmeAccountKeyScalar()`.
    private let accountKeyScalarProvider: @MainActor () -> Data?
    /// Pluggable for tests: override the IRK derivation. Default derives
    /// via `Keystore.deriveIRK(reason:)`.
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey

    public init(
        server: FlagshipServerClient,
        mailbox: SecretMailboxClient,
        serverDomain: String,
        username: @escaping @MainActor () -> String?,
        accountKeyScalarProvider: (@MainActor () -> Data?)? = nil,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil
    ) {
        self.server = server
        self.mailbox = mailbox
        self.serverDomain = serverDomain
        self.username = username
        self.accountKeyScalarProvider = accountKeyScalarProvider ?? { Keystore.acmeAccountKeyScalar() }
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    /// Build + seal + sign + deliver. Idempotent to re-tap: a re-run mints
    /// a fresh `grantId` (the box releases the latest grant for its STK).
    public func grant() async {
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }

        // This device must hold the #28 account-key scalar to seal it. A
        // non-admin device (or one that never minted a cert) cannot grant.
        guard let scalar = accountKeyScalarProvider() else {
            phase = .failed("This device can't grant cert-minting autonomy — only the device that set up TLS holds the account key.")
            return
        }

        // 1. Re-resolve the box STK from the directory (the trust anchor).
        phase = .resolving
        let stkHex: String
        do {
            let dir = try await mailbox.fetchPods(username: user)
            guard let resolved = dir.identityPubKey(forServerDomain: serverDomain) else {
                phase = .failed("Couldn't find this box in your account directory — it may not have finished setup yet.")
                return
            }
            stkHex = resolved
        } catch {
            phase = .failed("Couldn't reach the directory: \(error.localizedDescription)")
            return
        }
        guard let stkPub = HexUtil.decode(stkHex), stkPub.count == 32 else {
            phase = .failed("This box's identity key is malformed.")
            return
        }

        // 2. Build + seal + IRK-sign the grant FOR that box STK.
        phase = .signing
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await signer("Grant cert-minting autonomy to \(serverDomain)")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }
        let signed: AcmeAccountKeyGrantProducer.SignedGrant
        do {
            signed = try AcmeAccountKeyGrantProducer.makeGrant(
                accountKeyScalar: scalar,
                boxStkEd25519Pub: stkPub,
                username: user,
                irk: irk
            )
        } catch {
            phase = .failed("Couldn't seal the account key for this box: \(error.localizedDescription)")
            return
        }

        // 3. Hexify into the wire body + POST to the domain-scoped endpoint.
        let body = AcmeAccountKeyGrantMintRequest(
            grant: .init(
                grantId: signed.grant.grantId,
                username: signed.grant.username,
                accountKeyId: signed.grant.accountKeyId,
                recipientPubKey: HexUtil.encode(signed.grant.recipientPubKey),
                sealedAccountKey: HexUtil.encode(signed.grant.sealedAccountKey),
                issuedAt: signed.grant.issuedAt,
                expiresAt: signed.grant.expiresAt
            ),
            signature: HexUtil.encode(signed.signature)
        )

        phase = .posting
        do {
            let resp = try await server.grantAcmeAccountKeyAutonomy(serverDomain: serverDomain, body: body)
            phase = .completed(accountKeyId: resp.accountKeyId)
        } catch ScreensClientError.http(let status, _) where status == 403 {
            phase = .failed("The cloud rejected the grant. Sign in again and retry.")
        } catch ScreensClientError.http(let status, _) where status == 404 {
            phase = .failed("That box is no longer registered to your account.")
        } catch ScreensClientError.http(let status, let msg) {
            phase = .failed("Server error (\(status)): \(msg)")
        } catch {
            phase = .failed("Couldn't reach the server: \(error.localizedDescription)")
        }
    }
}
