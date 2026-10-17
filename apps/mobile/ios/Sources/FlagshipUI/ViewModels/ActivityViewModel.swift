import Foundation
import Observation
import FlagshipAPI

public struct ActivityFeed: Sendable {
    public let recentInstalls: [RecentInstallEvent]
    /// What this server did (its own log: updates, migration, backups,
    /// imports, app changes, shares), newest first.
    public let boxEvents: [BoxActivityEntry]
    public let pairedSessions: [PairedSessionSummary]
    /// Non-nil when the daemon reports a J.3/J.4 reissuance snapshot
    /// (post-recovery walk). Surfaces as a card on Activity that
    /// links into the Settings → Cloud recovery → Re-attach progress
    /// screen. Mirrors webapp activity.js fan-out.
    public let postRecovery: PostRecoverySnapshot?
    /// Account-level audit events from flagshipserver.com — device
    /// disconnects, IRK rotations, wipe-restart, recovery setup. Pulled
    /// alongside the daemon-side install events so the user sees their
    /// account history in one place. Sorted descending by seq.
    public let auditEvents: [AuditEvent]
    /// True when the last fetch filled its page, so older entries may exist.
    public var moreAudit: Bool = false
    public var moreBoxEvents: Bool = false
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
    private static let pageSize = 30
    private var auditLimit = ActivityViewModel.pageSize
    private var boxLimit = ActivityViewModel.pageSize

    /// Asks for the next page of account events (the list grows in place).
    public func loadMoreAudit() async { auditLimit += Self.pageSize; await load(quiet: true) }
    public func loadMoreBoxEvents() async { boxLimit += Self.pageSize; await load(quiet: true) }

    public init(
        client: any ScreensClient,
        server: (any FlagshipServerClient)? = nil,
        username: @MainActor @escaping () -> String? = { nil }
    ) {
        self.client = client
        self.server = server
        self.currentUsername = username
    }

    public func load() async { await load(quiet: false) }

    private func load(quiet: Bool) async {
        if !quiet { state = .loading }
        do {
            async let detail = client.serverDetail()
            async let sessions = client.pairedSessionsList()
            let limit = boxLimit
            async let boxEvents: [BoxActivityEntry] = {
                (try? await client.boxActivity(limit: limit, before: nil)) ?? []
            }()
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
            let auditN = auditLimit
            async let audit: [AuditEvent] = ActivityViewModel.fetchAuditOrEmpty(
                server: serverRef,
                username: username,
                limit: auditN
            )
            var feed = try await ActivityFeed(
                recentInstalls: detail.recentInstallEvents,
                boxEvents: boxEvents,
                pairedSessions: sessions.sessions,
                postRecovery: recovery,
                auditEvents: audit
            )
            feed.moreAudit = feed.auditEvents.count >= auditN
            feed.moreBoxEvents = feed.boxEvents.count >= limit
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
        limit: Int
    ) async -> [AuditEvent] {
        guard let server, let username, !username.isEmpty else { return [] }
        do {
            return try await server.listAuditEvents(username: username, sinceSeq: 0, limit: limit).events
        } catch {
            return []
        }
    }
}

/// What the Activity list says for each kind of box event. The same table lives
/// in apps/web/public/webapp/lib/activityFeed.js and Android's BoxEventLabels
/// (parity/features.json: activity-feed); unknown kinds are shown humanized.
public enum BoxEventLabels {
    private static let labels: [String: String] = [
        "server.update.applied": "Server updated",
        "server.update.rolled-back": "Update rolled back",
        "server.update.refused": "Update refused",
        "server.debug-access.granted": "Debug access turned on",
        "server.debug-access.renewed": "Debug access renewed",
        "server.debug-access.expired": "Debug access ended",
        "server.debug-access.revoked": "Debug access turned off",
        "server.migration.taken-over": "Took over from the old server",
        "server.decommission.released": "Stopped serving",
        "server.decommission.awaiting-handoff": "Waiting to be wiped",
        "server.decommission.wiped": "Old server wiped",
        "server.decommission.wipe-failed": "Wipe failed",
        "server.decommission.stood-down": "Hand-off cancelled",
        "server.decommission.closed": "Server retired",
        "server.backup.started": "Backup started",
        "server.backup.created": "Backup ready",
        "server.backup.downloaded": "Backup downloaded",
        "server.backup.failed": "Backup failed",
        "server.restore.started": "Import started",
        "server.restore.finished": "Import finished",
        "server.restore.failed": "Import failed",
        "app.installed": "App installed",
        "app.access.edit": "Changed an app's internet access",
        "app.access.dismiss": "Dismissed an app's access request",
        "app.invite.create": "Invited someone to an app",
        "app.invite.withdraw": "Withdrew an invite",
        "app.update.accept": "Accepted an app update",
        "app.storage.full": "An app ran out of space",
        "app.storage.room": "An app has room again",
        "server.backup.download-approved": "Approved a backup download",
        "server.backup.policy": "Changed the backup policy",
        "server.backup.schedule": "Changed the backup schedule",
        "server.backup.removed": "Removed a backup",
        "server.backup.over-limit": "Backups are over their limit",
        "server.backup.under-limit": "Backups are back under their limit",
        "server.disk.full": "The disk is nearly full",
        "server.disk.room": "The disk has room again",
        "server.migration.paused": "Paused apps for the move",
        "server.migration.resumed": "Apps running again after the move",
        "server.restore.pulled": "Fetched the backup data",
        "server.restore.waiting": "Waiting for its backup",
        "app.updated": "App redeployed",
        "app.removed": "App removed",
        "share.granted": "Shared this server",
        "share.changed": "Changed a share",
        "share.revoked": "Ended a share",
        "share.left": "A person left a share",
        "share.signed-in": "A shared person signed in",
        "server.update": "Server updated by a co-manager",
        "server.state.corrupt": "This server found a damaged settings file and locked it down",
    ]

    /// The row's title, or nil when the entry isn't worth a row (the log also
    /// records every owner write as a generic `post /api/screens/...` line).
    public static func title(_ e: BoxActivityEntry) -> String? {
        if e.kind == nil, e.action.range(of: "^(get|post|put|patch|delete) /", options: [.regularExpression, .caseInsensitive]) != nil {
            return nil
        }
        let key = e.kind ?? e.action
        let words = key.replacingOccurrences(of: "[._-]+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        let human = words.isEmpty ? "Event" : words.prefix(1).uppercased() + words.dropFirst()
        var by = ""
        if e.actor?.kind == "share", let label = e.actor?.label, !label.isEmpty { by = " by \(label)" }
        return (labels[key] ?? human) + by
    }

    public static func symbol(_ e: BoxActivityEntry) -> String {
        let key = e.kind ?? e.action
        if !e.ok { return "exclamationmark.triangle.fill" }
        if key.hasPrefix("server.backup") || key.hasPrefix("server.restore") { return "externaldrive.fill" }
        if key.hasPrefix("server.decommission") || key.hasPrefix("server.migration") { return "shippingbox.fill" }
        if key.hasPrefix("server.update") { return "arrow.up.circle.fill" }
        if key.hasPrefix("server.debug-access") { return "terminal.fill" }
        if key.hasPrefix("server.disk") { return "internaldrive.fill" }
        if key.hasPrefix("app.") { return "app.badge.fill" }
        if key.hasPrefix("share.") { return "person.2.fill" }
        return "circle.fill"
    }
}
