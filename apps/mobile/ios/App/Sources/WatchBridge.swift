import Foundation
import WatchConnectivity
import FlagshipAPI
import FlagshipCore
import Flagship
#if canImport(UIKit)
import UIKit
#endif

/// Phone-side WatchConnectivity bridge.
///
/// Responsibilities:
///   1. Publishes the current pending-unlock list to the watch via
///      `applicationContext` (replaces on each push; the watch only
///      ever sees the latest). Triggered by `publishPending(_:)`.
///   2. Receives `WatchProtocol.ApproveCommand` over
///      `sendMessage(replyHandler:)`, runs the existing Face-ID
///      gated BAK signing path, and ships an `ApproveReply` back
///      synchronously.
///
/// Touches the Secure Enclave UMK on the phone side only — the watch
/// never holds key material.
@MainActor
final class WatchBridge: NSObject {
    static let shared = WatchBridge()

    private var client: (any ScreensClient)?
    private var lastSentApprovals: [WatchProtocol.PendingApproval] = []

    private override init() { super.init() }

    /// Call once at app start to wire the bridge to the live screens
    /// client. Idempotent.
    func activate(client: any ScreensClient) {
        self.client = client
        guard WCSession.isSupported() else { return }
        if WCSession.default.delegate !== self {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    /// Push the latest pending list to the watch. Skips if nothing
    /// changed (Watch Connectivity gates redundant context updates
    /// itself but the comparison saves a roundtrip).
    func publishPending(_ approvals: [PendingUnlockApproval]) {
        let mapped = approvals.map {
            WatchProtocol.PendingApproval(
                requestId: $0.requestId,
                serverFqdn: $0.serverFqdn,
                requestedAt: $0.requestedAt,
                ip: $0.ip
            )
        }
        if mapped == lastSentApprovals { return }
        lastSentApprovals = mapped
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        let ctx = WatchProtocol.PendingApprovalsContext(approvals: mapped)
        if let data = try? JSONEncoder().encode(ctx) {
            try? WCSession.default.updateApplicationContext(["pending": data])
        }
    }
}

extension WatchBridge: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {}

    #if os(iOS)
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // Reactivate so we keep receiving the next watch's messages
        // after the user switches paired watches.
        WCSession.default.activate()
    }
    #endif

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        guard let data = message["approve-unlock"] as? Data,
              let cmd = try? JSONDecoder().decode(WatchProtocol.ApproveCommand.self, from: data)
        else {
            replyHandler([:])
            return
        }
        Task { @MainActor in
            let reply = await self.handleApprove(requestId: cmd.requestId)
            if let data = try? JSONEncoder().encode(reply) {
                replyHandler(["reply": data])
            } else {
                replyHandler([:])
            }
        }
    }

    @MainActor
    private func handleApprove(requestId: String) async -> WatchProtocol.ApproveReply {
        guard let client else {
            return .init(requestId: requestId, ok: false, errorMessage: "App not ready.")
        }
        do {
            // Re-resolve the request against the phone's view so a
            // stale watch context can't trick us into approving
            // something that's no longer pending.
            let pending = try await client.unlockApprovalsPending()
            guard let approval = pending.pending.first(where: { $0.requestId == requestId }) else {
                return .init(requestId: requestId, ok: false, errorMessage: "Already handled or expired.")
            }
            let bak = try await Keystore.deriveBAK(
                serverId: approval.serverFqdn,
                reason: "Authorize unlock of \(approval.serverFqdn) (from Apple Watch)"
            )
            let claim = BootApproval(
                requestId: approval.requestId,
                serverFqdn: approval.serverFqdn,
                requestedAt: approval.requestedAt,
                approvedAt: Int64(Date().timeIntervalSince1970 * 1000)
            )
            let signed = try claim.sign(with: bak)
            try await client.approveUnlock(
                requestId: approval.requestId,
                body: UnlockApprovalApproveRequest(
                    signature: signed.signatureHex,
                    envelope: signed.envelopeBase64
                )
            )
            // Refresh the watch's view immediately so the row
            // disappears without a delay.
            if let updated = try? await client.unlockApprovalsPending().pending {
                publishPending(updated)
            }
            return .init(requestId: requestId, ok: true)
        } catch {
            return .init(requestId: requestId, ok: false, errorMessage: error.localizedDescription)
        }
    }
}
