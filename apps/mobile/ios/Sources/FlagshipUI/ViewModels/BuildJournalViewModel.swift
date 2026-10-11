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
    /// Sessions still held by the box (resumable), newest first. A daemon
    /// restart empties this; their journals stay in `list`.
    public private(set) var liveSessions: [VibeCodeSessionMeta] = []

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func loadList() async {
        openedBuildId = nil
        list = .loading
        async let sessions = try? client.vibeCodeSessions().sessions
        do {
            let builds = try await client.buildSessions().builds
            liveSessions = ((await sessions) ?? []).sorted { $0.startedAt > $1.startedAt }
            list = .loaded(builds)
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

    /// Past builds the box no longer holds a session for.
    public func endedBuilds(_ builds: [BuildSummary]) -> [BuildSummary] {
        let live = Set(liveSessions.map(\.sessionId))
        return builds.filter { !live.contains($0.buildId) && $0.open != true }
    }

    /// Git imports and IDE builds the box still holds (and whose names it keeps).
    public func openBuilds(_ builds: [BuildSummary]) -> [BuildSummary] {
        let live = Set(liveSessions.map(\.sessionId))
        return builds.filter { $0.open == true && !live.contains($0.buildId) }
    }

    /// The journal's service name for a live session, once it has one.
    public func name(for session: VibeCodeSessionMeta, builds: [BuildSummary]) -> String {
        session.name ?? builds.first { $0.buildId == session.sessionId }?.displayName
            ?? session.serviceId?.components(separatedBy: "--").last ?? "Unnamed build"
    }

    public private(set) var discardError: String?

    /// Stop a session and delete it on the box, which frees its name.
    public func discard(_ session: VibeCodeSessionMeta) async {
        discardError = nil
        do {
            try await client.vibeCodeDiscard(sessionId: session.sessionId)
            liveSessions.removeAll { $0.sessionId == session.sessionId }
        } catch {
            discardError = ScreensClientError.userFacing(error)
        }
    }

    /// Forget an open git or IDE build on the box, which frees its name.
    public func discard(build: BuildSummary) async {
        discardError = nil
        do {
            try await client.buildDiscard(buildId: build.buildId)
            await loadList()
        } catch {
            discardError = ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error)
        }
    }

    /// Pop from a timeline back to the list view.
    public func closeDetail() {
        openedBuildId = nil
        detail = .idle
    }
}
