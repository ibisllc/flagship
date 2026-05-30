import Foundation
import WatchConnectivity
#if canImport(WidgetKit)
import WidgetKit
#endif

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
    /// Shared between the watch app and the watch widget extension via
    /// App Group `group.com.flagshipserver.app` (W2). The widget reads
    /// this key from `UserDefaults(suiteName:)` to render the
    /// complication.
    static let timelineDefaultsKey = "flagship.watch.provision-timeline-v1"
    static let appGroupSuiteName = "group.com.flagshipserver.app"

    private static var sharedDefaults: UserDefaults {
        UserDefaults(suiteName: appGroupSuiteName) ?? .standard
    }

    private override init() {
        super.init()
        // Rehydrate the last snapshots so a cold launch isn't blank
        // even if the watch hasn't reconnected to the iPhone yet.
        if let data = UserDefaults.standard.data(forKey: Self.pendingDefaultsKey),
           let ctx = try? JSONDecoder().decode(WatchProtocol.PendingApprovalsContext.self, from: data) {
            self.pending = ctx
        }
        // Timeline is read from the App Group so a cold watch launch +
        // a cold widget reload see the same snapshot. Falls back to
        // standard defaults so older builds that wrote to the standard
        // suite are still recoverable on first run.
        let timelineData =
            Self.sharedDefaults.data(forKey: Self.timelineDefaultsKey)
            ?? UserDefaults.standard.data(forKey: Self.timelineDefaultsKey)
        if let data = timelineData,
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
            // Persist to the App Group so the watch widget extension
            // (W2) can read the same snapshot, and to the standard
            // suite as a cold-launch fallback.
            Self.sharedDefaults.set(data, forKey: Self.timelineDefaultsKey)
            UserDefaults.standard.set(data, forKey: Self.timelineDefaultsKey)
            #if canImport(WidgetKit)
            // Kick the widget timeline so the complication updates
            // within a heartbeat of the phase transition.
            WidgetCenter.shared.reloadAllTimelines()
            #endif
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
