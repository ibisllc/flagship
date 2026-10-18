import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Cancel a pending order: release the reserved name (`.com` drops the routing
/// claim so the name can be used again), then revoke the install auth-code.
///
/// A failure comes back as the reason in plain words (`UserErrorText`) instead
/// of one fixed "check your connection" line, so a refusal `.com` sent and a
/// dropped connection no longer read the same. A row that names no
/// `<server>.<user>` (an old ghost) holds no name on `.com`, so it is removed
/// without a call. Shared by the pending page, the delivered page, Home's
/// context action and the failed-install card. Mirrors Android's
/// `CancelPendingOrder`.
public enum CancelPendingOrder {

    public enum Outcome: Equatable, Sendable {
        case cancelled(releasedName: Bool)
        case failed(String)
    }

    /// The sensitive-order key (the admin root when this device holds one).
    public typealias ReleaseKey = @MainActor (_ reason: String) async throws -> Curve25519.Signing.PrivateKey
    /// The auth-code revoke is an owner-IRK order; nil when it can't be had.
    public typealias RevokeKey = @MainActor (_ reason: String, _ orderKey: Curve25519.Signing.PrivateKey) async -> Curve25519.Signing.PrivateKey

    @MainActor
    public static func run(
        pod: PodInfo,
        username: String,
        server: any FlagshipServerClient,
        releaseKey: ReleaseKey = { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) },
        revokeKey: RevokeKey = { reason, orderKey in
            Keystore.hasAdminRoot ? ((try? await Keystore.deriveIRK(reason: reason)) ?? orderKey) : orderKey
        },
        now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) async -> Outcome {
        if !Endpoints.isWellFormedServerFqdn(pod.fqdn) { return .cancelled(releasedName: false) }
        let reason = "Cancel server \(pod.name)"
        do {
            let issuedAt = now()
            let orderKey = try await releaseKey(reason)
            let releaseSig = try orderKey.signature(for: ReleaseServerName.canonicalBytes(
                username: username, serverDomain: pod.fqdn, issuedAt: issuedAt
            ))
            try await server.releaseServerName(.init(
                request: .init(username: username, serverDomain: pod.fqdn, issuedAt: issuedAt),
                signature: HexUtil.encode(releaseSig)
            ))
            // The release already revoked active codes server-side; this is
            // belt and braces (403/404 count as already gone).
            if let serial = pod.pendingAuthCodeSerial, !serial.isEmpty {
                let revokeSigner = await revokeKey(reason, orderKey)
                if let sig = try? revokeSigner.signature(for: AuthCodeRevoke.canonicalBytes(
                    serial: serial, username: username, issuedAt: issuedAt
                )) {
                    try? await server.revokeAuthCode(.init(
                        request: .init(serial: serial, username: username, issuedAt: issuedAt),
                        signature: HexUtil.encode(sig)
                    ))
                }
            }
            return .cancelled(releasedName: true)
        } catch is CancellationError {
            return .failed(failureSentence(CancellationError()))
        } catch {
            return .failed(failureSentence(error))
        }
    }

    /// What the person reads when the cancel didn't go through.
    public static func failureSentence(_ error: Error) -> String {
        "Couldn't cancel this order. \(UserErrorText.of(error)) The name stays reserved until it is cancelled."
    }

    /// The button's label once a cancel has failed.
    public static let retryLabel = "Try cancelling again"
}
