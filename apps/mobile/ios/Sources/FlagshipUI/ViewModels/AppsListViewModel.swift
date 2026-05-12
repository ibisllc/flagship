import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class AppsListViewModel {
    public private(set) var state: LoadingState<[FlagshipAPI.AppSummary]> = .idle
    public var searchQuery: String = ""

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
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
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
