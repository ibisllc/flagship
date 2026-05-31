import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipCore
import FlagshipAPI

/// P14 Phase 2 — drives the Settings → Companion requests surface.
///
/// Loads `GET /api/screens/companion/pending-writes` (owner-gated).
/// Approve parses the intent → IRK-signs the corresponding destination
/// envelope (`releaseServerName` / `revokeServer`) → on destination
/// success records `POST /api/screens/companion/resolve-pending` with
/// `approved`. Deny posts the resolve directly with `denied`.
///
/// Failure on the destination POST does NOT resolve the row — the
/// companion's request stays pending until the owner retries (or it
/// expires server-side).
@MainActor
@Observable
public final class CompanionRequestsViewModel {

    public private(set) var state: LoadingState<[CompanionPendingWrite]> = .idle
    /// requestIds whose Approve/Deny is in flight. Drives the per-row
    /// spinner + disables the buttons.
    public private(set) var resolvePending: Set<String> = []
    /// Per-row failure message — surfaces the destination-POST error so
    /// the user understands why nothing changed.
    public private(set) var rowError: [String: String] = [:]

    private let client: any ScreensClient
    private let server: any FlagshipServerClient
    private let username: () -> String?
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        client: any ScreensClient,
        server: any FlagshipServerClient,
        username: @escaping () -> String?,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.server = server
        self.username = username
        self.signer = signer ?? { reason in
            try await Keystore.deriveIRK(reason: reason)
        }
        self.now = now
    }

    public func load() async {
        state = .loading
        do {
            let r = try await client.companionPendingWrites()
            state = .loaded(r.pending.sorted { $0.queuedAt < $1.queuedAt })
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    public func approve(_ request: CompanionPendingWrite) async {
        rowError[request.requestId] = nil
        resolvePending.insert(request.requestId)
        defer { resolvePending.remove(request.requestId) }
        do {
            switch request.kind {
            case "release-server":
                try await dispatchReleaseServer(intent: request.intent)
            case "revoke-server":
                try await dispatchRevokeServer(intent: request.intent)
            default:
                rowError[request.requestId] = "Unsupported request kind — open your browser to handle"
                return
            }
        } catch {
            rowError[request.requestId] = error.localizedDescription
            return
        }
        await postResolve(requestId: request.requestId, outcome: "approved")
    }

    public func deny(_ request: CompanionPendingWrite) async {
        rowError[request.requestId] = nil
        resolvePending.insert(request.requestId)
        defer { resolvePending.remove(request.requestId) }
        await postResolve(requestId: request.requestId, outcome: "denied")
    }

    private func postResolve(requestId: String, outcome: String) async {
        do {
            _ = try await client.companionResolvePending(
                CompanionResolvePendingRequest(requestId: requestId, outcome: outcome)
            )
            if case .loaded(var rows) = state {
                rows.removeAll { $0.requestId == requestId }
                state = .loaded(rows)
            }
        } catch {
            rowError[requestId] = error.localizedDescription
        }
    }

    private func dispatchReleaseServer(intent: [String: AnyCodable]) async throws {
        guard let user = username(), !user.isEmpty else {
            throw CompanionRequestsError.noAccount
        }
        guard let serverDomain = string(from: intent["serverDomain"]) else {
            throw CompanionRequestsError.malformedIntent("serverDomain")
        }
        let intentUsername = string(from: intent["username"]) ?? user
        let issuedAt = self.now()
        let irk = try await signer("Approve release-server for \(serverDomain)")
        let canonical = ReleaseServerName.canonicalBytes(
            username: intentUsername,
            serverDomain: serverDomain,
            issuedAt: issuedAt
        )
        let signature = try irk.signature(for: canonical)
        try await server.releaseServerName(
            ReleaseServerNameRequest(
                request: .init(
                    username: intentUsername,
                    serverDomain: serverDomain,
                    issuedAt: issuedAt
                ),
                signature: HexUtil.encode(signature)
            )
        )
    }

    private func dispatchRevokeServer(intent: [String: AnyCodable]) async throws {
        guard let user = username(), !user.isEmpty else {
            throw CompanionRequestsError.noAccount
        }
        guard let serverId = string(from: intent["revokedServerId"]) else {
            throw CompanionRequestsError.malformedIntent("revokedServerId")
        }
        guard let reason = string(from: intent["reason"]),
              ServerRevocationClaim.reasons.contains(reason)
        else {
            throw CompanionRequestsError.malformedIntent("reason")
        }
        let userId = string(from: intent["userId"]) ?? user
        let issuedAt = self.now()
        let irk = try await signer("Approve revoke-server for \(serverId)")
        let canonical = ServerRevocationClaim.canonicalBytes(
            userId: userId,
            revokedServerId: serverId,
            reason: reason,
            issuedAt: issuedAt
        )
        let signature = try irk.signature(for: canonical)
        try await server.revokeServer(
            ServerRevocationRequest(
                request: .init(
                    userId: userId,
                    revokedServerId: serverId,
                    reason: reason,
                    issuedAt: issuedAt
                ),
                signature: HexUtil.encode(signature)
            )
        )
    }

    private func string(from value: AnyCodable?) -> String? {
        guard let v = value?.value else { return nil }
        if let s = v as? String { return s }
        return nil
    }
}

public enum CompanionRequestsError: LocalizedError {
    case noAccount
    case malformedIntent(String)

    public var errorDescription: String? {
        switch self {
        case .noAccount: return "No active account on this device."
        case .malformedIntent(let field): return "Companion intent is missing field: \(field)"
        }
    }
}
