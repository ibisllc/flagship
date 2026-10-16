import Foundation

public extension WatchProtocol {
    /// What the phone publishes to the watch, projected from its own state
    /// (the server list and the account-level request inbox), so the watch
    /// shows waiting boxes and servers whichever phone screen was opened.
    /// Mirrors Android's WatchBridge.approvalsFrom / updateStatus.
    enum PhoneProjection {
        /// Live boot-unlock requests from the inbox. The request id is the
        /// inbox row's id (`<fqdn>#<nonce>`), which the phone's Approve path
        /// matches against the verified pending list.
        public static func approvals(inbox: [BoxRequest], nowMs: Int64) -> [PendingApproval] {
            inbox.filter { $0.type == .unlockKey && $0.expiresAt > nowMs }
                .map { PendingApproval(requestId: $0.id, serverFqdn: $0.serverDomain, requestedAt: $0.issuedAt, ip: nil) }
        }

        /// The account's servers in the phone's order; revoked ones left out.
        public static func servers(pods: [PodInfo], leaderPodId: String?,
                                   isWaiting: (PodInfo) -> Bool) -> [ServerStatus] {
            pods.filter { !$0.isRevoked && !$0.fqdn.isEmpty }.map { pod in
                ServerStatus(name: pod.name.isEmpty ? pod.fqdn : pod.name,
                             fqdn: pod.fqdn.lowercased(),
                             state: isWaiting(pod) ? "waiting" : pod.status.rawValue,
                             isLeader: pod.podId == leaderPodId)
            }
        }

        /// Inbox rows, each replaced by the Approvals screen's richer row (it
        /// carries the box's IP) for the same request; oldest first.
        public static func merged(inbox: [PendingApproval], screen: [PendingApproval]) -> [PendingApproval] {
            var out: [String: PendingApproval] = [:]
            for a in inbox { out[a.requestId.lowercased()] = a }
            for a in screen { out[a.requestId.lowercased()] = a }
            return out.values.sorted { ($0.requestedAt, $0.requestId) < ($1.requestedAt, $1.requestId) }
        }
    }
}
