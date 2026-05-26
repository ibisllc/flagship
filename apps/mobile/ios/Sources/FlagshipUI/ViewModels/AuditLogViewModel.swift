import Foundation
import Observation
import FlagshipAPI

/// Backs the dedicated full-page audit-log viewer (P5). Mirrors the
/// canonical webapp `views/audit-log.js`: a paginated, time-sorted list
/// of every account-level audit event from flagshipserver.com
/// (`GET /api/users/:u/audit?since=&limit=`).
///
/// Pagination note: the `.com` endpoint returns rows DESC by `seq`,
/// `since` is an EXCLUSIVE LOWER bound, and `limit` is server-capped at
/// 50. We page by growing the request window (`limit += pageSize`) and
/// re-reading from `since: 0`, then merging by `seq`. "Load more" stops
/// once the server returns fewer rows than the requested window (no more
/// history) or the 50-row cap is reached. Events are always presented
/// newest-first.
@MainActor
@Observable
public final class AuditLogViewModel {
    public enum Status: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    /// Server-side per-request cap (mirrors MAX_LIMIT in
    /// packages/control-plane/src/auditEvents.ts).
    public static let maxLimit = 50

    public private(set) var status: Status = .idle
    /// Events newest-first (descending `seq`).
    public private(set) var events: [AuditEvent] = []
    /// Whether another "load more" page is available.
    public private(set) var canLoadMore: Bool = false
    public private(set) var loadingMore: Bool = false

    private let server: any FlagshipServerClient
    private let username: String
    private let pageSize: Int
    /// The window we last requested (`limit`). Grows on each load-more.
    private var requestedLimit: Int

    public init(
        server: any FlagshipServerClient,
        username: String,
        pageSize: Int = 30
    ) {
        self.server = server
        self.username = username
        self.pageSize = max(1, pageSize)
        self.requestedLimit = max(1, pageSize)
    }

    /// Fresh load (also the pull-to-refresh path). Resets the window.
    public func load() async {
        status = .loading
        requestedLimit = pageSize
        await fetch(limit: requestedLimit, replacing: true)
    }

    /// Grow the window by one page and re-read. No-op while a load is in
    /// flight, when there's nothing more to fetch, or once the server cap
    /// is hit.
    public func loadMore() async {
        guard canLoadMore, !loadingMore, status == .loaded else { return }
        loadingMore = true
        defer { loadingMore = false }
        requestedLimit = min(Self.maxLimit, requestedLimit + pageSize)
        await fetch(limit: requestedLimit, replacing: true)
    }

    private func fetch(limit: Int, replacing: Bool) async {
        guard !username.isEmpty else {
            events = []
            canLoadMore = false
            status = .loaded
            return
        }
        do {
            let resp = try await server.listAuditEvents(
                username: username, sinceSeq: 0, limit: limit
            )
            // Defensive: the Mock + Worker both return DESC, but sort
            // here so the screen never depends on transport ordering.
            let sorted = resp.events.sorted { $0.seq > $1.seq }
            events = sorted
            // More history is available iff the server filled the window
            // AND we haven't hit its hard cap.
            canLoadMore = sorted.count >= limit && limit < Self.maxLimit
            status = .loaded
        } catch {
            // Keep any already-shown events on a load-more failure so the
            // list doesn't blank out; only a fresh load surfaces .failed.
            if replacing && events.isEmpty {
                status = .failed(error.localizedDescription)
            } else {
                status = .loaded
            }
        }
    }

    // MARK: - Event kind → label / icon mapping (docs/revocation-ui.md)

    /// Human label for an event kind. Mirrors the inline Activity feed +
    /// docs/revocation-ui.md. Unknown kinds fall back to the raw string.
    public static func label(for kind: String) -> String {
        switch kind {
        case "device-disconnected": return "Disconnected device"
        case "device-replaced":     return "Replaced device"
        case "device-added":        return "Added device"
        case "wipe-restart":        return "Wiped & restarted account"
        case "recovery-set-up":     return "Set up recovery"
        case "recovery-rotated":    return "Rotated recovery passkey"
        case "app-renamed":         return "Renamed app URL"
        default:                    return kind
        }
    }

    /// SF Symbol for an event kind (per docs/revocation-ui.md).
    public static func icon(for kind: String) -> String {
        switch kind {
        case "device-disconnected": return "lock.open.trianglebadge.exclamationmark"
        case "device-replaced":     return "arrow.triangle.2.circlepath.circle"
        case "device-added":        return "plus.circle"
        case "wipe-restart":        return "trash.fill"
        case "recovery-set-up":     return "key.horizontal.fill"
        case "recovery-rotated":    return "arrow.triangle.2.circlepath"
        case "app-renamed":         return "link.circle"
        default:                    return "circle.fill"
        }
    }
}
