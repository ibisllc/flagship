import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

/// Permissions a restore held back for ONE app (N09): approve the exact draft, or discard it.
@MainActor
@Observable
public final class RestoredAccessController {
    public private(set) var draft: RestoredAccessDraft?
    public private(set) var error: String?
    public private(set) var busy = false

    private let serviceRef: String
    private let client: any ScreensClient
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Date

    public init(
        serviceRef: String,
        client: any ScreensClient,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.serviceRef = serviceRef
        self.client = client
        self.signer = signer ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
        self.now = now
    }

    public func load() async {
        draft = (try? await client.restoredAccessDrafts())?.drafts.first { $0.serviceRef == serviceRef }
    }

    public func approve() async {
        guard let d = draft else { return }
        busy = true
        defer { busy = false }
        do {
            let order = RestoredAccessApproveOrder(serviceRef: serviceRef, draftSha256: d.sha256, issuedAt: Int64(now().timeIntervalSince1970 * 1000))
            let key = try await signer("Approve the permissions restored for \(serviceRef)")
            let sig = try key.signature(for: order.canonicalBytes())
            try await client.approveRestoredAccess(request: order.request, signatureHex: hex(Data(sig)))
            error = nil
        } catch {
            self.error = UserErrorText.of(error)
        }
        await load()
    }

    public func discard() async {
        busy = true
        defer { busy = false }
        do {
            try await client.discardRestoredAccess(serviceRef: serviceRef)
            error = nil
        } catch {
            self.error = UserErrorText.of(error)
        }
        await load()
    }
}

/// How ONE app takes updates (N11). A box without the setting, or an app that does not update from a
/// publisher, shows nothing.
@MainActor
@Observable
public final class UpdateModeController {
    public private(set) var state: UpdateModeState?
    public private(set) var error: String?

    private let serviceId: String
    private let client: any ScreensClient

    public init(serviceId: String, client: any ScreensClient) {
        self.serviceId = serviceId
        self.client = client
    }

    public func load() async { state = try? await client.updateMode(serviceId: serviceId) }

    public func choose(_ mode: String) async {
        do {
            try await client.setUpdateMode(serviceId: serviceId, mode: mode)
            error = nil
        } catch {
            self.error = UserErrorText.of(error)
        }
        await load()
    }
}

/// Letting ONE Remote browser session build or deploy ONE app (SEC-AUTH-002).
@MainActor
@Observable
public final class CompanionDelegationController {
    public private(set) var rows: [CompanionDelegationRow] = []
    public private(set) var error: String?

    private let sessionId: String
    private let client: any ScreensClient
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Date

    public init(
        sessionId: String,
        client: any ScreensClient,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.sessionId = sessionId
        self.client = client
        self.signer = signer ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
        self.now = now
    }

    public func load() async { rows = (try? await client.companionDelegations(sessionId: sessionId))?.delegations ?? [] }

    /// Signs exactly this session, app, operations and window; the window is capped at a day.
    public func allow(serviceRef: String, ops: [String], durationMs: Int64) async {
        do {
            let issued = Int64(now().timeIntervalSince1970 * 1000)
            let order = CompanionDelegationOrder(
                sessionId: sessionId, serviceRef: serviceRef, ops: ops, issuedAt: issued,
                expiresAt: issued + min(max(durationMs, 60_000), CompanionDelegationOrder.maxMs)
            )
            let key = try await signer("Let a browser change \(serviceRef)")
            let sig = try key.signature(for: order.canonicalBytes())
            try await client.allowCompanionBuild(request: order.request, signatureHex: hex(Data(sig)))
            error = nil
        } catch {
            self.error = UserErrorText.of(error)
        }
        await load()
    }

    public func end(serviceRef: String) async {
        do {
            try await client.endCompanionDelegation(sessionId: sessionId, serviceRef: serviceRef)
            error = nil
        } catch {
            self.error = UserErrorText.of(error)
        }
        await load()
    }
}
