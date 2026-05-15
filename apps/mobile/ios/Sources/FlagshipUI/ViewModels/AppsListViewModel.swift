import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class AppsListViewModel {
    public private(set) var state: LoadingState<[FlagshipAPI.AppSummary]> = .idle
    /// V2 — per-app links cache. Populated by `loadLinks` after the
    /// daemon's apps-list returns. Keyed by appId. Absent means
    /// either still loading or .com hasn't been reached; the row
    /// falls back to the daemon-provided urlLabel.
    public private(set) var linksByAppId: [String: AppLinksResponse] = [:]
    public var searchQuery: String = ""

    private let client: any ScreensClient
    private let server: (any FlagshipServerClient)?
    private let username: () -> String?

    public init(
        client: any ScreensClient,
        server: (any FlagshipServerClient)? = nil,
        username: @escaping () -> String? = { nil }
    ) {
        self.client = client
        self.server = server
        self.username = username
    }

    public var filteredApps: [FlagshipAPI.AppSummary] {
        guard let apps = state.value else { return [] }
        if searchQuery.isEmpty { return apps }
        let q = searchQuery.lowercased()
        return apps.filter {
            $0.appId.lowercased().contains(q)
                || $0.slug.lowercased().contains(q)
                || ($0.summary?.lowercased().contains(q) ?? false)
        }
    }

    public func load() async {
        state = .loading
        do {
            let resp = try await client.appsList()
            state = .loaded(resp.apps)
            // Kick off link fetches in parallel — surfaced as they
            // arrive so the list paints fast and the URLs fill in.
            await loadLinks(for: resp.apps)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// V2 — fan-out fetch of /api/users/:u/apps/:appId/links per app.
    /// Tolerates per-app failure (e.g. .com momentarily down for one
    /// row) without nuking the whole list. Updates `linksByAppId`
    /// as each result lands.
    private func loadLinks(for apps: [FlagshipAPI.AppSummary]) async {
        guard let server, let user = username(), !user.isEmpty else { return }
        await withTaskGroup(of: (String, AppLinksResponse?).self) { group in
            for app in apps {
                group.addTask { [appId = app.appId] in
                    do {
                        let r = try await server.getAppLinks(username: user, appId: appId)
                        return (appId, r)
                    } catch {
                        return (appId, nil)
                    }
                }
            }
            for await (appId, links) in group {
                if let links { linksByAppId[appId] = links }
            }
        }
    }
}
