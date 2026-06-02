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

    // MARK: - Security-alerts surface (Watch parity)

    /// applicationContext payload — phone → watch. A *compact* snapshot of
    /// the two glanceable security surfaces the watch app mirrors:
    ///
    ///   1. Pending boot approvals — boxes waiting for the phone to
    ///      release their boot secret (the same `PendingApproval` rows the
    ///      legacy unlock surface used).
    ///   2. Recent security events — a trimmed projection of the account
    ///      audit log (device replaced / disconnected, wipe-restart,
    ///      recovery changes …) so a quick wrist glance shows "did
    ///      something happen to my account."
    ///
    /// Replaces the previous snapshot on each send — the watch's WCSession
    /// delivers only the latest value, which is exactly the semantic we
    /// want. Kept Codable + Foundation-only so the watch target doesn't
    /// drag in FlagshipAPI: the phone projects its richer `AuditEvent`
    /// rows onto `SecurityAlert` before publishing (mirrors why
    /// `PendingApproval` is a thin watch-local mirror of the server's
    /// mailbox request).
    public struct SecurityAlertsContext: Codable, Hashable, Sendable {
        public let pendingApprovals: [PendingApproval]
        public let recentEvents: [SecurityAlert]
        public let updatedAt: Date

        public init(
            pendingApprovals: [PendingApproval] = [],
            recentEvents: [SecurityAlert] = [],
            updatedAt: Date = .init()
        ) {
            self.pendingApprovals = pendingApprovals
            self.recentEvents = recentEvents
            self.updatedAt = updatedAt
        }

        /// True when neither surface has anything to show — the watch
        /// renders its "all quiet" empty state.
        public var isEmpty: Bool {
            pendingApprovals.isEmpty && recentEvents.isEmpty
        }
    }

    /// One recent account security event, projected from the phone's
    /// `AuditEvent`. `kind` carries the raw audit `eventKind` so the
    /// watch can map label + icon itself (forward-compatible: an unknown
    /// future kind still renders with its raw string + a neutral icon).
    public struct SecurityAlert: Codable, Hashable, Identifiable, Sendable {
        /// Audit `seq` — stable, monotonic, unique per account. Doubles
        /// as the row id.
        public let seq: Int
        /// Raw audit event kind, e.g. `device-replaced`.
        public let kind: String
        /// Free-form server-supplied detail (may be empty).
        public let detail: String
        /// Short device-token prefix the event is attributed to.
        public let devicePrefix: String
        /// Unix-epoch milliseconds the event was posted.
        public let postedAt: Int64

        public var id: Int { seq }

        public init(seq: Int, kind: String, detail: String, devicePrefix: String, postedAt: Int64) {
            self.seq = seq
            self.kind = kind
            self.detail = detail
            self.devicePrefix = devicePrefix
            self.postedAt = postedAt
        }
    }

    /// Pure projection backing the watch security-alerts facade. Kept
    /// out of the SwiftUI view (and in FlagshipCore) so it's unit-tested
    /// directly — same split as `ProvisionTimelineLadder`. The watch view
    /// is a thin renderer over these outputs.
    public enum SecurityAlertsProjection {
        /// How many recent events the watch surfaces. The phone may send
        /// more; the watch is glanceable, so it trims to the newest few.
        public static let maxEvents = 5

        /// Pending boot approvals, oldest-first (the one that's been
        /// waiting longest is the most urgent to action, and matches the
        /// phone's mailbox ordering).
        public static func approvals(in ctx: SecurityAlertsContext?) -> [PendingApproval] {
            (ctx?.pendingApprovals ?? []).sorted { $0.requestedAt < $1.requestedAt }
        }

        /// Recent security events, newest-first, de-duplicated by `seq`
        /// and trimmed to `maxEvents`. Newest-first because the watch
        /// glance answers "what just happened."
        public static func events(in ctx: SecurityAlertsContext?) -> [SecurityAlert] {
            let raw = ctx?.recentEvents ?? []
            var seen = Set<Int>()
            let deduped = raw.filter { seen.insert($0.seq).inserted }
            return Array(deduped.sorted { $0.seq > $1.seq }.prefix(maxEvents))
        }

        /// True when there's nothing to show on either surface.
        public static func isEmpty(_ ctx: SecurityAlertsContext?) -> Bool {
            approvals(in: ctx).isEmpty && events(in: ctx).isEmpty
        }

        /// Human label for an audit event kind. Mirrors the phone's
        /// `AuditLogViewModel.label(for:)` so the watch reads the same as
        /// the iPhone activity feed. Unknown kinds fall back to the raw
        /// string.
        public static func label(for kind: String) -> String {
            switch kind {
            case "device-disconnected": return "Disconnected device"
            case "device-replaced":     return "Replaced device"
            case "device-added":        return "Added device"
            case "wipe-restart":        return "Wiped & restarted"
            case "recovery-set-up":     return "Set up recovery"
            case "recovery-rotated":    return "Rotated recovery passkey"
            case "app-renamed":         return "Renamed app URL"
            default:                    return kind
            }
        }

        /// SF Symbol for an audit event kind. Mirrors the phone's
        /// `AuditLogViewModel.icon(for:)`.
        public static func icon(for kind: String) -> String {
            switch kind {
            case "device-disconnected": return "lock.open.trianglebadge.exclamationmark"
            case "device-replaced":     return "arrow.triangle.2.circlepath.circle"
            case "device-added":        return "plus.circle"
            case "wipe-restart":        return "trash.fill"
            case "recovery-set-up":     return "key.horizontal.fill"
            case "recovery-rotated":    return "arrow.triangle.2.circlepath"
            case "app-renamed":         return "link.circle"
            default:                    return "shield.lefthalf.filled"
            }
        }
    }
}
