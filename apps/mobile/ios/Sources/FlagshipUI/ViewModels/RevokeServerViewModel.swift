import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// P13 — per-server kill-switch orchestrator.
///
/// IRK-signs a `ServerRevocation` envelope (one of {lost, stolen,
/// decommissioned}) and POSTs it to .com. On success the box is dead:
/// it will refuse to boot on its next reboot. The trust gate is the
/// IRK signature alone — same level as releasing a name — combined
/// with the hold-to-confirm gesture on the sheet (see ServerDetailScreen).
@Observable
@MainActor
public final class RevokeServerViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case signing
        case posting
        case completed
        case failed(String)
    }

    public enum Reason: String, CaseIterable, Sendable {
        case lost
        case stolen
        case decommissioned

        public var label: String {
            switch self {
            case .lost:           return "Lost"
            case .stolen:         return "Stolen"
            case .decommissioned: return "Decommissioned"
            }
        }
    }

    public private(set) var phase: Phase = .idle

    private let server: FlagshipServerClient
    private let username: () -> String?
    private let serverDomain: String
    /// Pluggable for tests: override the IRK derivation step. Default
    /// derives via `Keystore.deriveIRK(reason:)`.
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey

    public init(
        server: FlagshipServerClient,
        serverDomain: String,
        username: @escaping () -> String?,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil
    ) {
        self.server = server
        self.serverDomain = serverDomain
        self.username = username
        self.signer = signer ?? { reason in
            try await Keystore.deriveIRK(reason: reason)
        }
    }

    public func run(reason: Reason) async {
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        phase = .signing
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await signer("Revoke server \(serverDomain)")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let canonical = ServerRevocationClaim.canonicalBytes(
            userId: user,
            revokedServerId: serverDomain,
            reason: reason.rawValue,
            issuedAt: issuedAt
        )
        let signature: Data
        do {
            signature = try irk.signature(for: canonical)
        } catch {
            phase = .failed("Couldn't sign: \(error.localizedDescription)")
            return
        }

        phase = .posting
        do {
            try await server.revokeServer(
                ServerRevocationRequest(
                    request: .init(
                        userId: user,
                        revokedServerId: serverDomain,
                        reason: reason.rawValue,
                        issuedAt: issuedAt
                    ),
                    signature: HexUtil.encode(signature)
                )
            )
        } catch ScreensClientError.http(let status, _) where status == 403 {
            phase = .failed("The server rejected the request. Sign in again and retry.")
            return
        } catch ScreensClientError.http(let status, _) where status == 404 {
            phase = .failed("That server is already gone — nothing to revoke.")
            return
        } catch let error as ScreensClientError {
            // UX-B — plain language, no raw status code or server message;
            // UX-A — a cert-pin mismatch reads as "someone may be intercepting".
            phase = .failed(error.errorDescription ?? "That didn't work. Try again in a moment.")
            return
        } catch {
            phase = .failed("Couldn't reach the server. Check your connection and try again.")
            return
        }
        phase = .completed
    }
}
