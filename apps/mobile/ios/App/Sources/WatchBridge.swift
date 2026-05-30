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
/// The legacy unlock-approval watch feature was removed along with the
/// plaintext boot-approval flow it drove. This keeps a minimal WCSession
/// shell so a future relay-over-watch approval feature can hang off it;
/// today it holds no pending state and replies empty to any message.
@MainActor
final class WatchBridge: NSObject {
    static let shared = WatchBridge()

    private var client: (any ScreensClient)?

    /// Last published timeline context. Held so a re-send after a
    /// pending-approvals change preserves the timeline, since
    /// applicationContext is "latest snapshot replaces previous".
    private var timeline: WatchProtocol.ProvisionTimelineContext?

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

    private func pushApplicationContext() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        var payload: [String: Any] = [:]
        if let timeline,
           let data = try? JSONEncoder().encode(timeline) {
            payload["provision-timeline"] = data
        }
        // The applicationContext call REPLACES the prior snapshot, so an
        // empty payload (no timeline + no approvals) is the documented
        // way to clear the watch surface.
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
