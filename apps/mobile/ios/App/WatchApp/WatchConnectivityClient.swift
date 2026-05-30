import Foundation
import WatchConnectivity

/// Watch-side WatchConnectivity wrapper.
///
/// - Reads `applicationContext` (the phone replaces it on each send;
///   the watch only sees the most recent snapshot — that's exactly the
///   semantic we want). Two payloads share the dictionary today:
///     * `pending` — `PendingApprovalsContext` (legacy unlock-approval
///       surface, kept wired for the future relay path).
///     * `provision-timeline` — `ProvisionTimelineContext` (W1 — the
///       install-progress ladder rendered by `ProvisionTimelineWatchView`).
/// - Sends `WatchProtocol.ApproveCommand` to the phone via
///   `sendMessage(_:replyHandler:errorHandler:)` so the phone gets a
///   reply ack we can use to flip the row UI.
///
/// Both payloads are persisted to UserDefaults on receipt so a cold
/// watch-app launch picks up the most-recent snapshot even before
/// WCSession redelivers it.
@MainActor
final class WatchConnectivityClient: NSObject, ObservableObject {
    static let shared = WatchConnectivityClient()

    @Published var pending: WatchProtocol.PendingApprovalsContext = .init()
    @Published var provisionTimeline: WatchProtocol.ProvisionTimelineContext?
    @Published var inFlightRequestId: String? = nil
    @Published var lastError: String? = nil
    @Published var lastApprovedId: String? = nil

    private static let pendingDefaultsKey = "flagship.watch.pending-v1"
    private static let timelineDefaultsKey = "flagship.watch.provision-timeline-v1"

    private override init() {
        super.init()
        // Rehydrate the last snapshots so a cold launch isn't blank
        // even if the watch hasn't reconnected to the iPhone yet.
        if let data = UserDefaults.standard.data(forKey: Self.pendingDefaultsKey),
           let ctx = try? JSONDecoder().decode(WatchProtocol.PendingApprovalsContext.self, from: data) {
            self.pending = ctx
        }
        if let data = UserDefaults.standard.data(forKey: Self.timelineDefaultsKey),
           let ctx = try? JSONDecoder().decode(WatchProtocol.ProvisionTimelineContext.self, from: data) {
            self.provisionTimeline = ctx
        }
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        let context = WCSession.default.receivedApplicationContext
        applyApplicationContext(context)
    }

    func approve(_ approval: WatchProtocol.PendingApproval) async {
        guard WCSession.default.isReachable else {
            lastError = "iPhone not reachable. Bring it nearby and try again."
            return
        }
        inFlightRequestId = approval.requestId
        defer { inFlightRequestId = nil }
        do {
            let cmd = WatchProtocol.ApproveCommand(requestId: approval.requestId)
            let payload = try JSONEncoder().encode(cmd)
            let reply: WatchProtocol.ApproveReply = try await withCheckedThrowingContinuation { cont in
                WCSession.default.sendMessage(
                    ["approve-unlock": payload],
                    replyHandler: { resp in
                        guard let data = resp["reply"] as? Data,
                              let parsed = try? JSONDecoder().decode(WatchProtocol.ApproveReply.self, from: data) else {
                            cont.resume(throwing: NSError(domain: "watch", code: -1))
                            return
                        }
                        cont.resume(returning: parsed)
                    },
                    errorHandler: { err in cont.resume(throwing: err) }
                )
            }
            if reply.ok {
                lastApprovedId = reply.requestId
                lastError = nil
            } else {
                lastError = reply.errorMessage ?? "Approval failed."
            }
        } catch {
            lastError = "Couldn't reach iPhone: \(error.localizedDescription)"
        }
    }

    private func applyApplicationContext(_ context: [String: Any]) {
        if let data = context["pending"] as? Data,
           let ctx = try? JSONDecoder().decode(WatchProtocol.PendingApprovalsContext.self, from: data) {
            self.pending = ctx
            UserDefaults.standard.set(data, forKey: Self.pendingDefaultsKey)
        }
        if let data = context["provision-timeline"] as? Data,
           let ctx = try? JSONDecoder().decode(WatchProtocol.ProvisionTimelineContext.self, from: data) {
            self.provisionTimeline = ctx
            UserDefaults.standard.set(data, forKey: Self.timelineDefaultsKey)
        }
    }
}

extension WatchConnectivityClient: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {}

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.applyApplicationContext(applicationContext) }
    }
}
