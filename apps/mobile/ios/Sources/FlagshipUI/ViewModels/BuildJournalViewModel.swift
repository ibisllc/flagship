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
    /// Why the opened build's last run failed, as the box says it (a restart
    /// cuts off an AI run or a go-live and keeps the files).
    public private(set) var openedFailure: String?
    /// The opened build's mode ("git" | "mcp" | "scratch"), once known.
    public private(set) var openedMode: String?
    /// The opened build was handed to the box to go live: no AI may run on it.
    public private(set) var openedSealed = false
    /// Every chat the box holds (active, ready, failed, deployed, cancelled;
    /// finished ones for 30 days), newest activity first.
    public private(set) var liveSessions: [VibeCodeSessionMeta] = []

    /// One of the account's servers whose builds the list shows.
    public struct Server: Sendable {
        public let fqdn: String
        public let name: String
        public let client: any ScreensClient
        public init(fqdn: String, name: String, client: any ScreensClient) {
            self.fqdn = fqdn.lowercased()
            self.name = name
            self.client = client
        }
    }

    private let client: any ScreensClient
    private let servers: [Server]
    /// The server each listed session and build lives on (FQDN), when the
    /// list spans servers.
    public private(set) var sessionServer: [String: String] = [:]
    public private(set) var buildServer: [String: String] = [:]
    /// Servers whose builds couldn't be read this time, by name.
    public private(set) var unreachableServers: [String] = []

    /// `servers`: every server of the account this device can ask. With two
    /// or more, the list shows the builds of all of them, each row naming
    /// its server (as the webapp's does); else only `client`'s.
    public init(client: any ScreensClient, servers: [Server] = []) {
        self.client = client
        self.servers = servers
    }

    public var spansServers: Bool { servers.count > 1 }

    public func serverName(forSession id: String) -> String? { name(of: sessionServer[id]) }
    public func serverName(forBuild id: String) -> String? { name(of: buildServer[id]) }

    private func name(of fqdn: String?) -> String? {
        guard spansServers, let fqdn else { return nil }
        return servers.first { $0.fqdn == fqdn }?.name
    }

    private func clientFor(_ fqdn: String?) -> any ScreensClient {
        guard let fqdn, let s = servers.first(where: { $0.fqdn == fqdn }) else { return client }
        return s.client
    }

    public func loadList() async {
        openedBuildId = nil
        list = .loading
        if spansServers {
            await loadEveryServer()
            return
        }
        async let sessions = try? client.vibeCodeSessions().sessions
        do {
            let builds = try await client.buildSessions().builds
            liveSessions = Self.newestFirst((await sessions) ?? [])
            list = .loaded(builds)
        } catch {
            // The sessions list is a build-platform ENTRY call — a 404 means the
            // box can't build services (vs. loadDetail's session-scoped 404,
            // which legitimately means that one build is gone).
            list = .failed(ScreensClientError.buildPlatformAbsent(error)
                ?? ScreensClientError.userFacing(error))
        }
    }

    private struct ServerBuilds: Sendable {
        let index: Int
        let sessions: [VibeCodeSessionMeta]
        let builds: [BuildSummary]
        let error: String?
    }

    /// Every server at once; a server that fails is named in
    /// `unreachableServers`, and only when all fail does the list fail.
    private func loadEveryServer() async {
        let targets = servers
        let results = await withTaskGroup(of: ServerBuilds.self) { group in
            for (i, s) in targets.enumerated() {
                let c = s.client
                group.addTask {
                    async let sessions = try? c.vibeCodeSessions().sessions
                    do {
                        let builds = try await c.buildSessions().builds
                        return ServerBuilds(index: i, sessions: (await sessions) ?? [], builds: builds, error: nil)
                    } catch {
                        let msg = ScreensClientError.buildPlatformAbsent(error) ?? ScreensClientError.userFacing(error)
                        return ServerBuilds(index: i, sessions: [], builds: [], error: msg)
                    }
                }
            }
            var out: [ServerBuilds] = []
            for await r in group { out.append(r) }
            return out.sorted { $0.index < $1.index }
        }
        var sessions: [VibeCodeSessionMeta] = []
        var builds: [BuildSummary] = []
        var sessionAt: [String: String] = [:]
        var buildAt: [String: String] = [:]
        var failed: [String] = []
        for r in results {
            let server = targets[r.index]
            if r.error != nil { failed.append(server.name); continue }
            for s in r.sessions where sessionAt[s.sessionId] == nil {
                sessionAt[s.sessionId] = server.fqdn
                sessions.append(s)
            }
            for b in r.builds where buildAt[b.buildId] == nil {
                buildAt[b.buildId] = server.fqdn
                builds.append(b)
            }
        }
        sessionServer = sessionAt
        buildServer = buildAt
        unreachableServers = failed
        if failed.count == results.count, let first = results.first?.error {
            list = .failed(first)
            return
        }
        liveSessions = Self.newestFirst(sessions)
        list = .loaded(builds.sorted { $0.startedAt > $1.startedAt })
    }

    /// Newest activity first (`updatedAt`, else `startedAt`).
    nonisolated static func newestFirst(_ sessions: [VibeCodeSessionMeta]) -> [VibeCodeSessionMeta] {
        sessions.sorted { $0.lastActivity > $1.lastActivity }
    }

    public func loadDetail(buildId: String) async {
        openedBuildId = buildId
        openedFailure = nil
        openedMode = nil
        openedSealed = false
        detail = .loading
        let c = clientFor(buildServer[buildId])
        do {
            detail = .loaded(try await c.buildJournal(buildId: buildId).entries)
        } catch {
            detail = .failed(ScreensClientError.userFacing(error))
        }
        // Only a build the box still holds has a state; a past one 404s.
        if let st = try? await c.buildState(buildId: buildId).state, openedBuildId == buildId {
            openedMode = st.mode
            openedSealed = st.sealed == true
            if st.adapt?.status == "failed" { openedFailure = st.adapt?.reason ?? "The AI couldn't finish this build." }
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
            try await clientFor(sessionServer[session.sessionId]).vibeCodeDiscard(sessionId: session.sessionId)
            liveSessions.removeAll { $0.sessionId == session.sessionId }
        } catch {
            discardError = ScreensClientError.userFacing(error)
        }
    }

    /// Forget an open git or IDE build on the box, which frees its name.
    public func discard(build: BuildSummary) async {
        discardError = nil
        do {
            try await clientFor(buildServer[build.buildId]).buildDiscard(buildId: build.buildId)
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
