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
