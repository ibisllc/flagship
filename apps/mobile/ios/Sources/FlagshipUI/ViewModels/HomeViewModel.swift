import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class HomeViewModel {
    public private(set) var detail: LoadingState<ServerDetailResponse> = .idle

    private let client: any ScreensClient
    private let podContext: String?

    public init(client: any ScreensClient, podContext: String? = nil) {
        self.client = client
        self.podContext = podContext
    }

    public func load() async {
        detail = .loading
        do {
            // Mock-side: tell the in-memory client which pod fixture to
            // return. LiveScreensClient ignores this (its base URL is
            // already the right pod's daemon).
            if let mock = client as? MockScreensClient, let podContext {
                mock.podContext = podContext
            }
            let resp = try await client.serverDetail()
            detail = .loaded(resp)
        } catch {
            detail = .failed(error.localizedDescription)
        }
    }
}
