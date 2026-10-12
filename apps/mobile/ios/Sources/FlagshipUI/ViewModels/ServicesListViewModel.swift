import Foundation
import Observation
import FlagshipAPI
import FlagshipCore

@Observable
@MainActor
public final class ServicesListViewModel {
    /// Every app on any of the account's servers, once each.
    public private(set) var state: LoadingState<[FlagshipAPI.AppSummary]> = .idle
    /// V2 — per-service links cache. Populated by `loadLinks` after the
    /// daemon's apps-list returns. Keyed by serviceId. Absent means
    /// either still loading or .com hasn't been reached; the row
    /// falls back to the daemon-provided urlLabel.
    public private(set) var linksByServiceId: [String: AppLinksResponse] = [:]
    public var searchQuery: String = ""
    /// V7 — server filter. `nil` = "All servers" (the default). When set to
    /// a specific podId, the list shows the apps that server lists.
    public var serverFilter: String? = nil
    /// V7 — pods the user has on file, for the dropdown's names.
    public var availablePods: [(podId: String, name: String)] = []
    /// The servers whose apps lists make up the list (docs/app-placement.md
    /// §6). Empty: only the shell's server is asked.
    public var servers: [PodInfo] = []

    private let client: any ScreensClient
    private let clients: PodScreensClientFactory?
    private let homeFqdn: () -> String?
    private let server: (any FlagshipServerClient)?
    private let username: () -> String?

    /// Each server's last apps list, kept when a later ask fails so its apps
    /// stay listed (as "can't reach").
    private var listings: [String: [FlagshipAPI.AppSummary]] = [:]
    /// Servers whose latest ask answered.
    private var reachable: Set<String> = []

    /// `client` answers for the shell's server (`homeFqdn`); `clients` reaches
    /// the others.
    public init(
        client: any ScreensClient,
        clients: PodScreensClientFactory? = nil,
        homeFqdn: @escaping () -> String? = { nil },
        server: (any FlagshipServerClient)? = nil,
        username: @escaping () -> String? = { nil }
    ) {
        self.client = client
        self.clients = clients
        self.homeFqdn = homeFqdn
        self.server = server
        self.username = username
    }

    public var filteredApps: [FlagshipAPI.AppSummary] {
        guard let apps = state.value else { return [] }
        var out = apps
        if let podId = serverFilter {
            if let fqdn = servers.first(where: { $0.podId == podId })?.fqdn.lowercased(),
               let listed = listings[fqdn] {
                let ids = Set(listed.map(\.serviceId))
                out = out.filter { ids.contains($0.serviceId) }
            } else if let podName = availablePods.first(where: { $0.podId == podId })?.name {
                // Not asked per server (previews): match the pod name in the
                // app's `https://<label>.<server>.<user>.flagship.services`.
                let needle = podName.lowercased()
                out = out.filter { $0.url.lowercased().contains(".\(needle).") }
            }
        }
        if searchQuery.isEmpty { return out }
        let q = searchQuery.lowercased()
        return out.filter {
            $0.serviceId.lowercased().contains(q)
                || $0.slug.lowercased().contains(q)
                || ($0.summary?.lowercased().contains(q) ?? false)
        }
    }

    /// The list pill for an app: every server that lists it, combined.
    public func pill(for serviceId: String) -> AppStatusPill {
        var answers: [AppServerState?] = []
        for fqdn in orderedFqdns() {
            guard let app = listings[fqdn]?.first(where: { $0.serviceId == serviceId }) else { continue }
            answers.append(reachable.contains(fqdn) ? AppServerState(app) : nil)
        }
        return AppStatusPill.combined(answers)
    }

    /// The servers that list an app, the shell's own first.
    public func fqdns(for serviceId: String) -> [String] {
        orderedFqdns().filter { listings[$0]?.contains(where: { $0.serviceId == serviceId }) == true }
    }

    /// Where an app's page opens: nil for the shell's own server, else the
    /// server that has it (one that answered and runs it, if any).
    public func openFqdn(for serviceId: String) -> String? {
        let on = fqdns(for: serviceId)
        let home = homeKey
        if on.contains(home) { return nil }
        func state(_ fqdn: String) -> AppServerState? {
            guard reachable.contains(fqdn) else { return nil }
            return listings[fqdn]?.first(where: { $0.serviceId == serviceId }).map(AppServerState.init)
        }
        return on.first(where: { state($0)?.isLive == true })
            ?? on.first(where: { reachable.contains($0) })
            ?? on.first
    }

    public func load() async {
        if state.value == nil { state = .loading }
        let targets = await askTargets()
        let keep = Set(targets.map(\.0))
        listings = listings.filter { keep.contains($0.key) }
        reachable.formIntersection(keep)

        enum Answer: Sendable {
            case listed(String, [FlagshipAPI.AppSummary])
            case failed(String, String)
            case links(String, AppLinksResponse?)
        }
        let server = self.server
        let user = username().flatMap { $0.isEmpty ? nil : $0 }
        var linksAsked: Set<String> = []
        var firstError: String?
        await withTaskGroup(of: Answer.self) { group in
            for (fqdn, c) in targets {
                group.addTask {
                    do { return .listed(fqdn, try await c.appsList().apps) }
                    catch { return .failed(fqdn, error.localizedDescription) }
                }
            }
            for await answer in group {
                switch answer {
                case .listed(let fqdn, let apps):
                    listings[fqdn] = apps
                    reachable.insert(fqdn)
                    rebuild()
                    // V2 — fetch each new app's links as soon as one server
                    // lists it, so the URLs fill in as they arrive.
                    guard let server, let user else { continue }
                    for app in apps where !linksAsked.contains(app.serviceId) {
                        linksAsked.insert(app.serviceId)
                        group.addTask { [serviceId = app.serviceId] in
                            .links(serviceId, try? await server.getAppLinks(username: user, serviceId: serviceId))
                        }
                    }
                case .failed(let fqdn, let message):
                    reachable.remove(fqdn)
                    if firstError == nil { firstError = message }
                    if state.value != nil || !listings.isEmpty { rebuild() }
                case .links(let serviceId, let links):
                    if let links { linksByServiceId[serviceId] = links }
                }
            }
        }
        if listings.isEmpty, let firstError {
            state = .failed(firstError)
        } else {
            rebuild()
        }
    }

    /// The shell's server first (through `client`), then each other server.
    private func askTargets() async -> [(String, any ScreensClient)] {
        let home = homeKey
        var out: [(String, any ScreensClient)] = [(home, client)]
        guard let clients else { return out }
        for pod in CreationTarget.eligible(servers) {
            let fqdn = pod.fqdn.lowercased()
            if fqdn == home || out.contains(where: { $0.0 == fqdn }) { continue }
            out.append((fqdn, await clients.client(forFqdn: fqdn)))
        }
        return out
    }

    private var homeKey: String { homeFqdn()?.lowercased() ?? "" }

    private func orderedFqdns() -> [String] {
        let home = homeKey
        let others = CreationTarget.eligible(servers).map { $0.fqdn.lowercased() }.filter { $0 != home }
        return ([home] + others).filter { listings[$0] != nil }
            + listings.keys.filter { $0 != home && !others.contains($0) }.sorted()
    }

    /// One row per app across every server's list, the shell server's copy
    /// (and order) first.
    private func rebuild() {
        var seen: Set<String> = []
        var merged: [FlagshipAPI.AppSummary] = []
        for fqdn in orderedFqdns() {
            for app in listings[fqdn] ?? [] where seen.insert(app.serviceId).inserted {
                merged.append(app)
            }
        }
        state = .loaded(merged)
    }
}
