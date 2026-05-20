import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class ServicesListViewModel {
    public private(set) var state: LoadingState<[FlagshipAPI.AppSummary]> = .idle
    /// V2 — per-service links cache. Populated by `loadLinks` after the
    /// daemon's apps-list returns. Keyed by serviceId. Absent means
    /// either still loading or .com hasn't been reached; the row
    /// falls back to the daemon-provided urlLabel.
    public private(set) var linksByServiceId: [String: AppLinksResponse] = [:]
    public var searchQuery: String = ""
    /// V7 — server filter. `nil` = "All servers" (the default). When
    /// set to a specific podId, the services list is filtered to services
    /// running on that pod. Today's daemon AppsListResponse doesn't
    /// yet carry a `installedOn` field per service, so we approximate by
    /// matching the pod name against the canonical FQDN the daemon
    /// surfaces (e.g. `notes.home.alice.flagship.services` belongs
    /// to "home"). Once the daemon emits the membership list this
    /// match becomes exact.
    public var serverFilter: String? = nil
    /// V7 — pods the user has on file. The Services tab passes the
    /// current AppState.pods snapshot in so the dropdown can list
    /// each server by name. Default empty so the dropdown is hidden
    /// when the user has no pods yet.
    public var availablePods: [(podId: String, name: String)] = []

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
        var out = apps
        if let podId = serverFilter,
           let podName = availablePods.first(where: { $0.podId == podId })?.name {
            let needle = podName.lowercased()
            // Match services whose canonical URL contains the pod name as
            // a subdomain segment. The daemon's AppSummary.url has
            // the shape `https://<label>.<server>.<user>.flagship.services`,
            // so checking the lowercased URL is a stable approximation
            // until a real installedOn field lands.
            out = out.filter { $0.url.lowercased().contains(".\(needle).") }
        }
        if searchQuery.isEmpty { return out }
        let q = searchQuery.lowercased()
        return out.filter {
            $0.serviceId.lowercased().contains(q)
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

    /// V2 — fan-out fetch of /api/users/:u/apps/:serviceId/links per service.
    /// Tolerates per-service failure (e.g. .com momentarily down for one
    /// row) without nuking the whole list. Updates `linksByServiceId`
    /// as each result lands.
    private func loadLinks(for apps: [FlagshipAPI.AppSummary]) async {
        guard let server, let user = username(), !user.isEmpty else { return }
        await withTaskGroup(of: (String, AppLinksResponse?).self) { group in
            for app in apps {
                group.addTask { [serviceId = app.serviceId] in
                    do {
                        let r = try await server.getAppLinks(username: user, serviceId: serviceId)
                        return (serviceId, r)
                    } catch {
                        return (serviceId, nil)
                    }
                }
            }
            for await (serviceId, links) in group {
                if let links { linksByServiceId[serviceId] = links }
            }
        }
    }
}
