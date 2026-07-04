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
///      giver IRK, re-seal to the acquirer IRK, deposit via `client.postDiskKey`
///      — and, when this device holds the admin master root, deposits the §9.8
///      giver-root-signed admin hand-off (`client.postAdminHandoff`) so the box
///      re-pins the ACQUIRER's admin root at re-home.
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
    /// Injectable seams over `Keystore.hasAdminRoot` / `Keystore.adminRootKey`
    /// — the giver's admin master root signs the offer AND the §9.8 hand-off.
    private let hasAdminRoot: @MainActor () -> Bool
    private let adminRootKey: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey

    /// Derived once (in `start`) so the re-seal step needs no second biometric.
    private var irk: Curve25519.Signing.PrivateKey?
    /// The offer's nonce (from `start`) — the §9.8 hand-off canonical commits
    /// to it so the box can bind the proof to THIS transfer.
    private var transferNonce: String?

    public init(
        client: any ServerTransferClient,
        mailbox: any SecretMailboxClient,
        serverDomain: String,
        username: String,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        randomNonce: @escaping () -> Data = { ServerTransferFlow.random32() },
        hasAdminRoot: @escaping @MainActor () -> Bool = { Keystore.hasAdminRoot },
        adminRootKey: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil
    ) {
        self.client = client
        self.mailbox = mailbox
        self.serverDomain = serverDomain
        self.username = username
        self.now = now
        self.randomNonce = randomNonce
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
        self.hasAdminRoot = hasAdminRoot
        self.adminRootKey = adminRootKey ?? { reason in try await Keystore.adminRootKey(reason: reason) }
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
            // Slice D — the transfer OFFER is SENSITIVE ⇒ sign with the giver's
            // admin master root when present; the mailbox auth stays IRK, and the
            // stored `irk` above (used for the later disk-key re-seal) is unchanged.
            let orderKey = hasAdminRoot()
                ? try await adminRootKey("Transfer \(serverDomain) to another account")
                : nil
            let (body, qr) = try ServerTransferFlow.buildOffer(
                serverDomain: serverDomain, username: username, irk: key, orderKey: orderKey,
                issuedAt: now(), nonce: randomNonce(), authNonce: randomNonce()
            )
            transferNonce = qr.transferNonce
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
        } catch {
            phase = .failed("Ownership moved, but the disk key re-seal failed: \(error.localizedDescription). The new owner can retry from their device.")
            return true
        }
        // §9.8 — hand off admin authority: the box only trusts a new admin root
        // pinned via a proof signed by its CURRENT anchor (the giver root), so
        // the Face ID unseal here EMITS the hand-off signature (consent-as-
        // crypto). No admin root ⇒ legacy account, box has no pin — skip.
        if hasAdminRoot() {
            do {
                let giverRoot = try await adminRootKey("Hand off admin of \(serverDomain)")
                let body = try ServerTransferFlow.buildAdminHandoff(
                    serverDomain: serverDomain,
                    giverUsername: username,
                    acquirerUsername: claimed.acquirerUsername ?? "",
                    acquirerAdminRootPubHex: claimed.acquirerAdminRootPub ?? "",
                    giverAdminRoot: giverRoot,
                    transferNonce: transferNonce ?? "",
                    issuedAt: now()
                )
                try await client.postAdminHandoff(serverDomain: serverDomain, body: body)
            } catch {
                // Same shape as the re-seal failure: ownership already moved,
                // so degrade to retryable completed-with-warning.
                phase = .failed("Ownership moved, but the admin hand-off failed: \(error.localizedDescription). The new owner's box will wait for this hand-off before re-homing while it has a pinned admin key — retry the transfer hand-off from this device.")
                return true
            }
        }
        phase = .completed(newServerDomain: claimed.newServerDomain)
        return true
    }
}
