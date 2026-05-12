import Foundation
import Observation
import FlagshipAPI

public struct ActivityFeed: Sendable {
    public let recentInstalls: [RecentInstallEvent]
    public let pendingUnlocks: [PendingUnlockApproval]
    public let pairedSessions: [PairedSessionSummary]
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
            let feed = try await ActivityFeed(
                recentInstalls: detail.recentInstallEvents,
                pendingUnlocks: unlocks.pending,
                pairedSessions: sessions.sessions
            )
            state = .loaded(feed)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
