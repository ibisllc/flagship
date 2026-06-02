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
    private var approvals: [WatchProtocol.PendingApproval] = []
    private var events: [WatchProtocol.SecurityAlert] = []

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

    /// Replace the pending-boot-approvals half.
    func updateApprovals(_ approvals: [WatchProtocol.PendingApproval]) {
        self.approvals = approvals
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
        approvals = []
        events = []
        current = nil
        WatchBridge.shared.updateSecurityAlerts(nil)
    }

    private func commit() {
        let ctx = WatchProtocol.SecurityAlertsContext(
            pendingApprovals: approvals,
            recentEvents: events,
            updatedAt: Date()
        )
        current = ctx
        // An empty context clears the watch surface (WatchBridge drops an
        // empty alerts payload from the snapshot).
        WatchBridge.shared.updateSecurityAlerts(ctx.isEmpty ? nil : ctx)
    }
}
