import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI

/// The security sliver's data (SECURITY-HARDENING-PLAN.md 18.14) and the owner's answer to a waiting
/// publisher key (18.11). The box decides severities; this only reads them and, for a waiting key,
/// signs exactly "this service, this old key to this new key" with the account's sensitive key.
@MainActor
@Observable
public final class SecuritySliverViewModel {
    public private(set) var lines: [SliverLine] = []
    public private(set) var lostHistory = false
    public private(set) var waiting: [String: WaitingPublisherResponse.Waiting] = [:]
    public private(set) var error: String?

    private let client: any ScreensClient
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Date

    public init(
        client: any ScreensClient,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.client = client
        self.signer = signer ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
        self.now = now
    }

    public func refresh() async {
        do {
            let r = try await client.securitySliver()
            lines = r.lines
            lostHistory = r.lostHistory
            var w: [String: WaitingPublisherResponse.Waiting] = [:]
            for l in r.lines where l.kind == "publisher-key" && l.isActive {
                if let state = try? await client.publisherState(serviceId: l.target), let waitingKey = state.waiting, !waitingKey.rejected {
                    w[l.target] = waitingKey
                }
            }
            waiting = w
        } catch {
            // A box that does not have the sliver yet simply shows nothing.
        }
    }

    public func trust(serviceId: String) async {
        do {
            guard var statement = waiting[serviceId]?.trust else { error = "No new key is waiting for this service."; return }
            statement.issuedAt = Int64(now().timeIntervalSince1970 * 1000)
            let key = try await signer("Trust a new publisher key for \(serviceId)")
            try await client.trustPublisher(serviceId: serviceId, trust: statement, signatureHex: try statement.sign(with: key))
            error = nil
            await refresh()
        } catch {
            self.error = UserErrorText.of(error)
        }
    }

    public func reject(serviceId: String) async {
        do {
            try await client.rejectPublisher(serviceId: serviceId)
            error = nil
            await refresh()
        } catch {
            self.error = UserErrorText.of(error)
        }
    }
}
