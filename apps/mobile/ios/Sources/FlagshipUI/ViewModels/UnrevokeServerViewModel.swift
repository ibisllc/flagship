import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Undo a lost/stolen/decommissioned revoke. Signs a `ServerUnrevocation` with
/// the sensitive-order key (admin root when held, else the IRK) and POSTs it to
/// `.com`. The revoke deleted the box's stored self-unlock lease, so an
/// auto-unlock box asks the phone once on its next boot.
@Observable
@MainActor
public final class UnrevokeServerViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case working
        case completed
        case failed(String)
    }

    public static let completedMessage = "Server restored. If it unlocks on its own, approve its unlock once from your phone."

    public private(set) var phase: Phase = .idle

    private let server: any FlagshipServerClient
    private let serverDomain: String
    private let username: () -> String?
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        server: any FlagshipServerClient,
        serverDomain: String,
        username: @escaping () -> String?,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.server = server
        self.serverDomain = serverDomain
        self.username = username
        self.now = now
        self.signer = signer ?? { reason in
            try await Keystore.sensitiveOrderSigningKey(reason: reason)
        }
    }

    public func run() async {
        if case .working = phase { return }
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        phase = .working
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Un-revoke server \(serverDomain)")
        } catch {
            phase = .failed("Couldn't access your account key: \(UserErrorText.of(error))")
            return
        }
        let issuedAt = now()
        do {
            let sig = try key.signature(for: ServerUnrevocation.canonicalBytes(
                username: user, serverDomain: serverDomain, issuedAt: issuedAt
            ))
            _ = try await server.unrevokeServer(.init(
                request: .init(username: user, serverDomain: serverDomain, issuedAt: issuedAt),
                signature: HexUtil.encode(sig)
            ))
        } catch ScreensClientError.http(let status, _) where status == 403 {
            phase = .failed("The server rejected the request. Sign in again and retry.")
            return
        } catch ScreensClientError.http(let status, _) where status == 404 {
            phase = .failed("That server no longer exists.")
            return
        } catch ScreensClientError.http(let status, _) where status == 409 {
            phase = .failed("This server was deleted, transferred or retired and can't be restored.")
            return
        } catch let error as ScreensClientError {
            phase = .failed(error.errorDescription ?? "That didn't work. Try again in a moment.")
            return
        } catch {
            phase = .failed("Couldn't reach the server. Check your connection and try again.")
            return
        }
        phase = .completed
    }
}
