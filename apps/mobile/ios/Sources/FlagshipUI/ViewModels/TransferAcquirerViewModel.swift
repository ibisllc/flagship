import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// ACQUIRER side of transfer-a-box (docs/account-deletion-and-name-reclaim.md §4).
///
/// From Home → Add a server → "Take over a transferred box", the camera scans
/// the giver's QR. This VM parses it, then on confirm:
///   1. derives the acquirer owner IRK behind the biometric,
///   2. builds + signs a `ServerTransferClaim` binding the acquirer's username +
///      IRK pub to the offer's nonce (`ServerTransferFlow.buildClaim`),
///   3. POSTs it (`client.postClaim`) — `.com` re-homes the box to the
///      acquirer's namespace.
///
/// The disk-key pick-up (`claimDiskKey` → open with the acquirer IRK → deposit
/// the box-sealed lease) is a follow-on the box-side reburn validates; this VM
/// exposes `pickUpDiskKey()` for it but the claim itself is the headline action.
@Observable
@MainActor
public final class TransferAcquirerViewModel {
    public enum Phase: Equatable, Sendable {
        case idle
        /// A QR was scanned + parsed; awaiting the user's confirm.
        case scanned(serverDomain: String)
        case signing
        case posting
        /// Claimed; `newServerDomain` is the box's new canonical under this account.
        case claimed(newServerDomain: String?)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    public private(set) var offer: ServerTransferFlow.OfferQR?

    private let client: any ServerTransferClient
    private let username: String
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        client: any ServerTransferClient,
        username: String,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.username = username
        self.now = now
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    /// Reset to the scanner after a failure so the user can re-aim.
    public func resetForRescan() {
        offer = nil
        phase = .idle
    }

    /// Validate a scanned/pasted QR string. Returns true when it parses (the UI
    /// then shows the confirm). A non-transfer QR is reported via `.failed`.
    @discardableResult
    public func ingest(_ qrText: String) -> Bool {
        do {
            let parsed = try ServerTransferFlow.parseQR(qrText)
            offer = parsed
            phase = .scanned(serverDomain: parsed.serverDomain)
            return true
        } catch {
            phase = .failed("That isn't a Flagship transfer code.")
            return false
        }
    }

    /// Sign + POST the claim (biometric). Advances to `.claimed` on success.
    public func confirm() async {
        guard let parsed = offer else {
            phase = .failed("Scan a transfer code first.")
            return
        }
        phase = .signing
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Take over \(parsed.serverDomain)")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }
        do {
            let body = try ServerTransferFlow.buildClaim(
                offer: parsed, acquirerUsername: username, acquirerIrk: key, issuedAt: now()
            )
            phase = .posting
            let result = try await client.postClaim(serverDomain: parsed.serverDomain, body: body)
            phase = .claimed(newServerDomain: result.newServerDomain)
        } catch ServerTransferFlow.TransferError.expired {
            phase = .failed("This transfer code has expired. Ask the owner for a new one.")
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
        } catch {
            phase = .failed("Couldn't reach the broker. Check your connection and try again.")
        }
    }
}
