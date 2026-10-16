import Foundation
import FlagshipCore

/// iPhone-side aggregator that publishes the watch security-alerts
/// surface (pending boot approvals + recent account security events) to
/// the paired Watch via `WatchBridge`.
///
/// Mirrors `WatchTimelinePublisher`'s shape. FlagshipUI projects its
/// richer `AuditEvent` / `PendingSecretRequest` rows onto the thin
/// `WatchProtocol` wire types and forwards them through
/// `WatchSecurityAlertsBridge`; the App wires that bridge to this
/// publisher at boot. The two halves (approvals + events) can update
/// independently, so each call recomputes the whole context from the
/// most recent inputs and re-publishes.
@MainActor
final class WatchSecurityAlertsPublisher {
    static let shared = WatchSecurityAlertsPublisher()

    /// Most-recent inputs. Kept so an update to one half preserves the
    /// other when we recompute the published snapshot.
    /// Rows the Approvals screen loaded (they carry the box's IP).
    private var screenApprovals: [WatchProtocol.PendingApproval] = []
    /// Boxes waiting for their boot unlock in the account-level inbox the
    /// phone polls whichever screen is open (AppState.boxRequestInbox).
    private var inboxApprovals: [WatchProtocol.PendingApproval] = []
    private var events: [WatchProtocol.SecurityAlert] = []
    private var servers: WatchProtocol.ServersContext?

    /// Currently-published context. Mirrored to WCSession's
    /// applicationContext on every `commit`.
    private(set) var current: WatchProtocol.SecurityAlertsContext?

    private init() {}

    /// Wire the FlagshipCore bridge to this publisher. Call once at app
    /// start. Idempotent.
    func activate() {
        WatchSecurityAlertsBridge.shared.onApprovals = { [weak self] approvals in
            self?.updateApprovals(approvals)
        }
        WatchSecurityAlertsBridge.shared.onEvents = { [weak self] events in
            self?.updateEvents(events)
        }
    }

    /// Replace the Approvals screen's rows.
    func updateApprovals(_ approvals: [WatchProtocol.PendingApproval]) {
        screenApprovals = approvals
        commit()
    }

    /// The account's servers and the boxes waiting to start, from the app's
    /// own state: published on every server-list or inbox change, so the
    /// watch doesn't wait for the phone's Approvals screen to be opened.
    func updateFromApp(_ app: AppState, now: Date = Date()) {
        guard app.isPaired else {
            clear()
            return
        }
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        inboxApprovals = WatchProtocol.PhoneProjection.approvals(inbox: app.boxRequests, nowMs: nowMs)
        let list = WatchProtocol.PhoneProjection.servers(pods: app.pods, leaderPodId: app.leaderPodId,
                                                         isWaiting: { app.isAwaitingUnlock($0) })
        if list != servers?.servers {
            let next = WatchProtocol.ServersContext(servers: list, updatedAt: now)
            servers = next
            WatchBridge.shared.updateServers(list.isEmpty ? nil : next)
        }
        commit()
    }

    /// Replace the recent-security-events half.
    func updateEvents(_ events: [WatchProtocol.SecurityAlert]) {
        self.events = events
        commit()
    }

    /// Clear both surfaces — called on sign-out so a stale wrist glance
    /// doesn't outlive the session.
    func clear() {
        screenApprovals = []
        inboxApprovals = []
        events = []
        current = nil
        servers = nil
        WatchBridge.shared.updateSecurityAlerts(nil)
        WatchBridge.shared.updateServers(nil)
    }

    private func commit() {
        let ctx = WatchProtocol.SecurityAlertsContext(
            pendingApprovals: WatchProtocol.PhoneProjection.merged(inbox: inboxApprovals, screen: screenApprovals),
            recentEvents: events,
            updatedAt: Date()
        )
        current = ctx
        // An empty context clears the watch surface (WatchBridge drops an
        // empty alerts payload from the snapshot).
        WatchBridge.shared.updateSecurityAlerts(ctx.isEmpty ? nil : ctx)
    }
}
