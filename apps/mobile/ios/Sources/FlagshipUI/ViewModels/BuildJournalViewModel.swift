import Foundation
import Observation
import FlagshipAPI

/// Backs the build-journal viewer — the append-only history of how a
/// service was built, across every mode. Two entry points:
///   - `loadList()`               → the list of past builds.
///   - `loadDetail(buildId:)`     → that build's timeline.
///
/// Mirrors the canonical webapp `views/build-journal.js`.
@MainActor
@Observable
public final class BuildJournalViewModel {
    public private(set) var list: LoadingState<[BuildSummary]> = .idle
    public private(set) var detail: LoadingState<[BuildJournalEntry]> = .idle
    /// The build whose timeline `detail` holds (nil when showing the list).
    public private(set) var openedBuildId: String?

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func loadList() async {
        openedBuildId = nil
        list = .loading
        do {
            list = .loaded(try await client.buildSessions().builds)
        } catch {
            // The sessions list is a build-platform ENTRY call — a 404 means the
            // box can't build services (vs. loadDetail's session-scoped 404,
            // which legitimately means that one build is gone).
            list = .failed(ScreensClientError.buildPlatformAbsent(error)
                ?? ScreensClientError.userFacing(error))
        }
    }

    public func loadDetail(buildId: String) async {
        openedBuildId = buildId
        detail = .loading
        do {
            detail = .loaded(try await client.buildJournal(buildId: buildId).entries)
        } catch {
            detail = .failed(ScreensClientError.userFacing(error))
        }
    }

    /// Pop from a timeline back to the list view.
    public func closeDetail() {
        openedBuildId = nil
        detail = .idle
    }
}
