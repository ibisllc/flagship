import Foundation
import Observation
import FlagshipAPI

public struct ActivityFeed: Sendable {
    public let recentInstalls: [RecentInstallEvent]
    public let pairedSessions: [PairedSessionSummary]
    /// Non-nil when the daemon reports a J.3/J.4 reissuance snapshot
    /// (post-recovery walk). Surfaces as a card on Activity that
    /// links into the Settings → Recovery → Re-attach progress
    /// screen. Mirrors webapp activity.js fan-out.
    public let postRecovery: PostRecoverySnapshot?
    /// Account-level audit events from flagshipserver.com — device
    /// disconnects, IRK rotations, wipe-restart, recovery setup. Pulled
    /// alongside the daemon-side install events so the user sees their
    /// account history in one place. Sorted descending by seq.
    public let auditEvents: [AuditEvent]
}

@Observable
@MainActor
public final class ActivityViewModel {
    public private(set) var state: LoadingState<ActivityFeed> = .idle

    private let client: any ScreensClient
    /// Optional — only wired in production. When nil (older callers /
    /// tests that don't care about audit events), the audit section
    /// stays empty and the rest of the feed still loads.
    private let server: (any FlagshipServerClient)?
    private let currentUsername: @MainActor () -> String?

    public init(
        client: any ScreensClient,
        server: (any FlagshipServerClient)? = nil,
        username: @MainActor @escaping () -> String? = { nil }
    ) {
        self.client = client
        self.server = server
        self.currentUsername = username
    }

    public func load() async {
        state = .loading
        do {
            async let detail = client.serverDetail()
            async let sessions = client.pairedSessionsList()
            // Post-recovery is tolerated as missing — a daemon that
            // hasn't shipped P1.23 returns a non-2xx, and we render
            // the rest of the feed regardless. Mirrors the
            // try/catch in apps/web/public/webapp/views/activity.js.
            async let recovery: PostRecoverySnapshot? = {
                do { return try await client.postRecoveryStatus().report }
                catch { return nil }
            }()
            // Audit events live on flagshipserver.com (.com control
            // plane), not on the daemon. Tolerated as missing too —
            // a fresh install or a misconfigured Worker shouldn't
            // break the rest of the feed.
            // Capture deps before the async let — `currentUsername`
            // is MainActor-isolated so it has to be read on the
            // outer task, not inside the unstructured child.
            let username = currentUsername()
            let serverRef = server
            async let audit: [AuditEvent] = ActivityViewModel.fetchAuditOrEmpty(
                server: serverRef,
                username: username,
            )
            let feed = try await ActivityFeed(
                recentInstalls: detail.recentInstallEvents,
                pairedSessions: sessions.sessions,
                postRecovery: recovery,
                auditEvents: audit
            )
            state = .loaded(feed)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Helper for the audit-events async let. Static + nonisolated so
    /// it can be called from an unstructured child task without
    /// crossing actor isolation. Returns [] on any error — audit is
    /// non-essential, never breaks the main feed.
    private static func fetchAuditOrEmpty(
        server: (any FlagshipServerClient)?,
        username: String?,
    ) async -> [AuditEvent] {
        guard let server, let username, !username.isEmpty else { return [] }
        do {
            return try await server.listAuditEvents(username: username, sinceSeq: 0, limit: 20).events
        } catch {
            return []
        }
    }
}
