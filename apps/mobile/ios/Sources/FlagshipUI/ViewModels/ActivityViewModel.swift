import Foundation
import Observation
import FlagshipAPI

public struct ActivityFeed: Sendable {
    public let recentInstalls: [RecentInstallEvent]
    public let pendingUnlocks: [PendingUnlockApproval]
    public let pairedSessions: [PairedSessionSummary]
    /// Non-nil when the daemon reports a J.3/J.4 reissuance snapshot
    /// (post-recovery walk). Surfaces as a card on Activity that
    /// links into the Settings → Recovery → Re-attach progress
    /// screen. Mirrors webapp activity.js fan-out.
    public let postRecovery: PostRecoverySnapshot?
}

@Observable
@MainActor
public final class ActivityViewModel {
    public private(set) var state: LoadingState<ActivityFeed> = .idle

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func load() async {
        state = .loading
        do {
            async let detail = client.serverDetail()
            async let unlocks = client.unlockApprovalsPending()
            async let sessions = client.pairedSessionsList()
            // Post-recovery is tolerated as missing — a daemon that
            // hasn't shipped P1.23 returns a non-2xx, and we render
            // the rest of the feed regardless. Mirrors the
            // try/catch in apps/web/public/webapp/views/activity.js.
            async let recovery: PostRecoverySnapshot? = {
                do { return try await client.postRecoveryStatus().report }
                catch { return nil }
            }()
            let feed = try await ActivityFeed(
                recentInstalls: detail.recentInstallEvents,
                pendingUnlocks: unlocks.pending,
                pairedSessions: sessions.sessions,
                postRecovery: recovery
            )
            state = .loaded(feed)
            PendingApprovalsBroadcast.broadcast(feed.pendingUnlocks)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
