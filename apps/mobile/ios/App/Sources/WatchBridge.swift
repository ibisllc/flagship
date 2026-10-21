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
    /// Answers the watch's Approve with the phone's own approval path.
    private var approvals: WatchApprovalResponder?

    /// Last published timeline context. Held so a re-send after a
    /// security-alerts change preserves the timeline, since
    /// applicationContext is "latest snapshot replaces previous".
    private var timeline: WatchProtocol.ProvisionTimelineContext?

    /// Last published security-alerts context. Held for the same
    /// snapshot-replace reason as `timeline`.
    private var alerts: WatchProtocol.SecurityAlertsContext?

    /// Last published server list, held for the same reason.
    private var servers: WatchProtocol.ServersContext?

    private override init() { super.init() }

    /// Call once at app start to wire the bridge to the live screens
    /// client. Idempotent.
    func activate(
        client: any ScreensClient,
        mailbox: (any SecretMailboxClient)? = nil,
        currentUser: @escaping @MainActor () -> String? = { nil }
    ) {
        self.client = client
        if let mailbox {
            approvals = WatchApprovalResponder(
                delegateEnrolled: { Keystore.watchDelegateKey() != nil },
                hasSessionKey: { Keystore.hasSessionKey() },
                appInForeground: { Self.appInForeground() },
                onNeedsUnlock: { requestId in
                    // The app asks for the unlock once it is in front
                    // (ContentView); nothing here opens Face ID.
                    let fqdn = WatchBridge.shared.alerts?.pendingApprovals
                        .first(where: { $0.requestId.lowercased() == requestId.lowercased() })?.serverFqdn
                    WatchApprovalPrompt.shared.watchIsWaiting(serverFqdn: fqdn)
                },
                makeSource: {
                    guard let username = currentUser(), !username.isEmpty else { return nil }
                    return SecretRequestCoordinator(
                        mailbox: mailbox,
                        username: username,
                        irkProvider: { try await Keystore.deriveIRK(reason: String(localized: "Approve your box's boot unlock")) },
                        unsealSeedProvider: { serverDomain in
                            var seeds: [Data] = []
                            if let bak = try? await Keystore.deriveBAK(serverId: serverDomain, reason: String(localized: "Unseal the disk key")) {
                                seeds.append(bak.rawRepresentation)
                            }
                            if let irk = try? await Keystore.deriveIRK(reason: String(localized: "Unseal the disk key")) {
                                seeds.append(irk.rawRepresentation)
                            }
                            return seeds
                        },
                        watchDelegateKeyProvider: { Keystore.watchDelegateKey() }
                    )
                }
            )
        }
        guard WCSession.isSupported() else { return }
        if WCSession.default.delegate !== self {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    private static func appInForeground() -> Bool {
        #if canImport(UIKit)
        return UIApplication.shared.applicationState == .active
        #else
        return false
        #endif
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

    /// Publish the account's servers (nil clears the list on the watch).
    func updateServers(_ ctx: WatchProtocol.ServersContext?) {
        servers = ctx
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
        if let servers, !servers.servers.isEmpty,
           let data = try? JSONEncoder().encode(servers) {
            payload["servers"] = data
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
        guard let payload = message["approve-unlock"] as? Data,
              let cmd = try? JSONDecoder().decode(WatchProtocol.ApproveCommand.self, from: payload)
        else {
            replyHandler([:])
            return
        }
        let reply = UncheckedReply(send: replyHandler)
        Task { @MainActor in
            let answer: WatchProtocol.ApproveReply
            if let approvals = WatchBridge.shared.approvals {
                answer = await approvals.respond(to: cmd)
            } else {
                answer = .init(requestId: cmd.requestId, ok: false, errorMessage: WatchApprovalResponder.signedOut)
            }
            let data = (try? JSONEncoder().encode(answer)) ?? Data()
            reply.send(["reply": data])
        }
    }
}

/// WCSession's reply handler isn't Sendable; it is safe to call once from any thread.
private struct UncheckedReply: @unchecked Sendable {
    let send: ([String: Any]) -> Void
}
