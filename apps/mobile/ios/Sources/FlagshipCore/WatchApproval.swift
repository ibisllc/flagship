import Foundation

/// Wire types exchanged between the phone and the watch over
/// WatchConnectivity. Kept minimal + Codable so both sides can encode
/// via JSONEncoder without dragging in FlagshipAPI on the watch.
///
/// **Why a thin client?** The watch never holds Secure-Enclave key
/// material. When the user swipes-to-approve on the watch, we send an
/// `Approve` message to the phone, which derives the BAK from the UMK
/// and runs the existing approve flow. The watch only renders +
/// initiates. This keeps the security surface unchanged from the
/// phone-only model.
public enum WatchProtocol {
    /// applicationContext payload — phone → watch. Replaces the
    /// previous context on each send; the watch's WCSession delivers
    /// only the latest value, which is exactly the semantic we want.
    public struct PendingApprovalsContext: Codable, Hashable, Sendable {
        public let approvals: [PendingApproval]
        public let updatedAt: Date

        public init(approvals: [PendingApproval] = [], updatedAt: Date = .init()) {
            self.approvals = approvals
            self.updatedAt = updatedAt
        }
    }

    public struct PendingApproval: Codable, Hashable, Identifiable, Sendable {
        public let requestId: String
        public let serverFqdn: String
        public let requestedAt: Int64
        public let ip: String?

        public var id: String { requestId }

        public init(requestId: String, serverFqdn: String, requestedAt: Int64, ip: String?) {
            self.requestId = requestId
            self.serverFqdn = serverFqdn
            self.requestedAt = requestedAt
            self.ip = ip
        }
    }

    /// Message body for watch → phone "please approve this one." The
    /// phone validates the requestId against its current pending list
    /// before running the approval, so a stale watch send can't
    /// trick the phone into approving a non-existent request.
    public struct ApproveCommand: Codable, Sendable {
        public let kind: String        // "approve-unlock"
        public let requestId: String

        public init(requestId: String) {
            self.kind = "approve-unlock"
            self.requestId = requestId
        }
    }

    /// Phone → watch reply ack. Lets the watch flip the row to a
    /// terminal "✓ Approved" or "× Failed" state without re-fetching
    /// the entire list.
    public struct ApproveReply: Codable, Sendable {
        public let requestId: String
        public let ok: Bool
        public let errorMessage: String?

        public init(requestId: String, ok: Bool, errorMessage: String? = nil) {
            self.requestId = requestId
            self.ok = ok
            self.errorMessage = errorMessage
        }
    }
}
