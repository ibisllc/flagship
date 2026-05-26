import Foundation
import Observation
import FlagshipAPI
import FlagshipCore

/// P6 — drives the per-app invite manage screen. Fans out two reads
/// (`appInviteList` + `appInviteAccess`) in parallel and exposes a
/// revoke action that re-fetches both lists on success.
@MainActor
@Observable
public final class InviteManageViewModel {
    public struct Snapshot: Equatable, Sendable {
        public var pending: [AppInvitePendingSummary]
        public var access: [AppInviteAccessSummary]
        public init(pending: [AppInvitePendingSummary], access: [AppInviteAccessSummary]) {
            self.pending = pending
            self.access = access
        }
    }

    public private(set) var state: LoadingState<Snapshot> = .idle
    public private(set) var revokePending: Bool = false
    public private(set) var lastRevokeOutcome: String?

    public let serviceId: String
    private let client: any ScreensClient
    private let labelBook: any InviteLabelBook

    public init(serviceId: String, client: any ScreensClient, labelBook: any InviteLabelBook) {
        self.serviceId = serviceId
        self.client = client
        self.labelBook = labelBook
    }

    public func load() async {
        state = .loading
        do {
            async let pendingTask = client.appInviteList(serviceId: serviceId)
            async let accessTask = client.appInviteAccess(serviceId: serviceId)
            let (pendingResp, accessResp) = try await (pendingTask, accessTask)
            state = .loaded(Snapshot(pending: pendingResp.pending, access: accessResp.access))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Resolve the local label for a given opaqueTag. Returns nil when
    /// the issuance happened on another device (or after a wipe).
    public func label(for opaqueTagHex: String) -> InviteLabel? {
        labelBook.get(serviceId: serviceId, opaqueTagHex: opaqueTagHex)
    }

    public func revokeInvite(inviteId: String, opaqueTagHex: String?) async {
        await runRevoke(.invite(serviceId: serviceId, inviteId: inviteId), localTag: opaqueTagHex)
    }

    public func revokeAccess(irkPubKey: String, opaqueTagHex: String?) async {
        await runRevoke(.access(serviceId: serviceId, irkPubKey: irkPubKey), localTag: opaqueTagHex)
    }

    private func runRevoke(_ req: AppInviteRevokeRequest, localTag: String?) async {
        revokePending = true
        defer { revokePending = false }
        do {
            let resp = try await client.appInviteRevoke(req)
            if let tag = localTag, !tag.isEmpty {
                labelBook.remove(serviceId: serviceId, opaqueTagHex: tag)
            }
            lastRevokeOutcome = resp.alreadyRevoked == true ? "already revoked" : "revoked"
            await load()
        } catch {
            lastRevokeOutcome = error.localizedDescription
        }
    }
}
