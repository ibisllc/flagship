import Foundation
import WatchConnectivity

/// Watch-side WatchConnectivity wrapper.
///
/// - Reads `applicationContext` (the phone replaces it with the latest
///   PendingApprovalsContext whenever the phone's approval list
///   changes). The watch sees only the most recent snapshot.
/// - Sends `WatchProtocol.ApproveCommand` to the phone via
///   `sendMessage(_:replyHandler:errorHandler:)` so the phone gets a
///   reply ack we can use to flip the row UI.
@MainActor
final class WatchConnectivityClient: NSObject, ObservableObject {
    static let shared = WatchConnectivityClient()

    @Published var pending: WatchProtocol.PendingApprovalsContext = .init()
    @Published var inFlightRequestId: String? = nil
    @Published var lastError: String? = nil
    @Published var lastApprovedId: String? = nil

    private override init() { super.init() }

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        if let data = WCSession.default.receivedApplicationContext["pending"] as? Data {
            try? decode(data: data)
        }
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

    private func decode(data: Data) throws {
        let ctx = try JSONDecoder().decode(WatchProtocol.PendingApprovalsContext.self, from: data)
        self.pending = ctx
    }
}

extension WatchConnectivityClient: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {}

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let data = applicationContext["pending"] as? Data else { return }
        Task { @MainActor in try? self.decode(data: data) }
    }
}
