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
/// Publishes two glanceable surfaces to the paired watch via
/// `updateApplicationContext` (the watch only ever sees the latest
/// snapshot — exactly the semantic we want):
///
///   * `provision-timeline` — the in-flight install ladder (W1).
///   * `security-alerts` — pending boot approvals + recent account
///     security events, so a wrist glance surfaces "a box wants
///     approval" / "something changed on my account" without unlocking
///     the phone.
///
/// Both are held as the bridge's current state because the
/// applicationContext call replaces the whole snapshot — re-sending one
/// surface must preserve the other.
@MainActor
final class WatchBridge: NSObject {
    static let shared = WatchBridge()

    private var client: (any ScreensClient)?

    /// Last published timeline context. Held so a re-send after a
    /// security-alerts change preserves the timeline, since
    /// applicationContext is "latest snapshot replaces previous".
    private var timeline: WatchProtocol.ProvisionTimelineContext?

    /// Last published security-alerts context. Held for the same
    /// snapshot-replace reason as `timeline`.
    private var alerts: WatchProtocol.SecurityAlertsContext?

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

    /// Publish a new provision-timeline snapshot to the paired watch.
    /// Pass nil to clear the surface. Best-effort: dropped silently if
    /// no watch is paired or WCSession isn't supported (simulator).
    func updateProvisionTimeline(_ ctx: WatchProtocol.ProvisionTimelineContext?) {
        timeline = ctx
        pushApplicationContext()
    }

    /// Publish a new security-alerts snapshot (pending boot approvals +
    /// recent security events). Pass nil (or an empty context) to clear
    /// the surface — the watch then shows its "all quiet" state.
    func updateSecurityAlerts(_ ctx: WatchProtocol.SecurityAlertsContext?) {
        alerts = ctx
        pushApplicationContext()
    }

    private func pushApplicationContext() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        var payload: [String: Any] = [:]
        if let timeline,
           let data = try? JSONEncoder().encode(timeline) {
            payload["provision-timeline"] = data
        }
        // Only carry security-alerts when there's something to show, so a
        // cleared surface drops out of the snapshot rather than shipping
        // an empty array that the watch would have to special-case.
        if let alerts, !alerts.isEmpty,
           let data = try? JSONEncoder().encode(alerts) {
            payload["security-alerts"] = data
        }
        // The applicationContext call REPLACES the prior snapshot, so an
        // empty payload (no timeline + no alerts) is the documented way
        // to clear the watch surface.
        do {
            try session.updateApplicationContext(payload)
        } catch {
            // Best-effort UX surface; never crash the phone over a
            // failed watch update.
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
        // The watch approvals feature was retired with the legacy flow.
        replyHandler([:])
    }
}
