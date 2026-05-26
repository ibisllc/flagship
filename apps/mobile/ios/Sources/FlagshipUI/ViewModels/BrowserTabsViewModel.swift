import Foundation
import Observation
import FlagshipAPI

/// P8 — backs the BrowserTabsScreen list. Fetches the daemon's open-tab
/// list for a given serviceId via `ScreensClient.browserTabsList`.
@MainActor
@Observable
public final class BrowserTabsViewModel {
    public private(set) var state: LoadingState<[BrowserTab]> = .idle

    public let serviceId: String
    private let client: any ScreensClient

    public init(serviceId: String, client: any ScreensClient) {
        self.serviceId = serviceId
        self.client = client
    }

    public func load() async {
        state = .loading
        do {
            let resp = try await client.browserTabsList(serviceId: serviceId)
            state = .loaded(resp.tabs)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
