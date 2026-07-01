import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// GIVER side of transfer-a-box (docs/account-deletion-and-name-reclaim.md §4).
///
/// On the server-detail screen the owner taps "Transfer to another account",
/// types the FQDN to confirm + passes the biometric; this VM:
///   1. derives the owner IRK behind the biometric (in `signer`),
///   2. builds + signs a one-time short-TTL `ServerTransferOffer` + IRK
///      mailbox-auth (`ServerTransferFlow.buildOffer`),
///      and deposits it (`client.postOffer`),
///   3. exposes the QR text to render,
///   4. then polls `client.pollClaim` until the acquirer claims; on the claim it
///      runs the disk-key re-seal (Layer B): unseal the box's disk key with the
///      giver IRK, re-seal to the acquirer IRK, deposit via `client.postDiskKey`.
///
/// The biometric fires ONCE (in `signer`); re-using the derived IRK for the
/// re-seal avoids a second prompt.
@Observable
@MainActor
public final class TransferGiverViewModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case signing
        case posting
        /// Offer deposited; `qrText` is ready to render. Polling for a claim.
        case awaitingClaim
        /// The acquirer claimed; re-sealing the disk key for them.
        case resealing
        /// Done — ownership moved + the disk key handed off.
        case completed(newServerDomain: String?)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    public private(set) var qrText: String?

    private let client: any ServerTransferClient
    private let mailbox: any SecretMailboxClient
    private let serverDomain: String
    private let username: String
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64
    private let randomNonce: () -> Data

    /// Derived once (in `start`) so the re-seal step needs no second biometric.
    private var irk: Curve25519.Signing.PrivateKey?

    public init(
        client: any ServerTransferClient,
        mailbox: any SecretMailboxClient,
        serverDomain: String,
        username: String,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        randomNonce: @escaping () -> Data = { ServerTransferFlow.random32() }
    ) {
        self.client = client
        self.mailbox = mailbox
        self.serverDomain = serverDomain
        self.username = username
        self.now = now
        self.randomNonce = randomNonce
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    /// Build + deposit the offer (biometric). Advances to `.awaitingClaim` with
    /// `qrText` set on success.
    public func start() async {
        phase = .signing
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Transfer \(serverDomain) to another account")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }
        irk = key
        do {
            let (body, qr) = try ServerTransferFlow.buildOffer(
                serverDomain: serverDomain, username: username, irk: key,
                issuedAt: now(), nonce: randomNonce(), authNonce: randomNonce()
            )
            phase = .posting
            _ = try await client.postOffer(serverDomain: serverDomain, body: body)
            // Render the QR as the UNIVERSAL LINK (Slice C) so the acquirer's
            // NATIVE camera opens it straight into the take-over flow; the in-app
            // scanner still accepts it (parseScanned decodes the `o=` param).
            qrText = try ServerTransferFlow.transferUniversalLink(qr)
            phase = .awaitingClaim
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
        } catch {
            phase = .failed("Couldn't reach the broker. Check your connection and try again.")
        }
    }

    /// One claim poll. When the acquirer has claimed, run the disk-key re-seal
    /// and finish. Call it on a timer while `.awaitingClaim`. Returns true once
    /// the transfer is complete (the caller can stop polling).
    @discardableResult
    public func pollOnce() async -> Bool {
        guard case .awaitingClaim = phase, let key = irk else { return false }
        let poll: TransferClaimPoll?
        do {
            let auth = try ServerTransferFlow.buildMailboxAuth(
                username: username, irk: key, issuedAt: now(), nonce: randomNonce()
            )
            poll = try await client.pollClaim(serverDomain: serverDomain, auth: auth)
        } catch {
            return false // transient — keep polling
        }
        guard let claimed = poll, let acquirerIrk = claimed.acquirerIrkPub else { return false }

        phase = .resealing
        do {
            // Unseal the box's disk key (sealed FOR the giver IRK at install) and
            // re-seal it to the acquirer IRK. A box with no LUKS key (un-encrypted)
            // has nothing to hand off — skip straight to completion.
            let sealed = try? await mailbox.fetchSealedLuksKey(serverDomain: serverDomain)
            if let sealedHex = sealed?.sealedKey {
                let diskKey = try ServerTransferFlow.openGiverDiskKey(sealedHex: sealedHex, giverIrk: key)
                let auth = try ServerTransferFlow.buildDiskKeyDeposit(
                    serverDomain: serverDomain, username: username, irk: key,
                    diskKey: diskKey, acquirerIrkPubHex: acquirerIrk, issuedAt: now(),
                    authNonce: randomNonce()
                )
                try await client.postDiskKey(serverDomain: serverDomain, body: auth)
            }
            phase = .completed(newServerDomain: claimed.newServerDomain)
            return true
        } catch {
            phase = .failed("Ownership moved, but the disk key re-seal failed: \(error.localizedDescription). The new owner can retry from their device.")
            return true
        }
    }
}
