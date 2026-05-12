import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class HomeViewModel {
    public private(set) var detail: LoadingState<ServerDetailResponse> = .idle

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func load() async {
        detail = .loading
        do {
            let resp = try await client.serverDetail()
            detail = .loaded(resp)
        } catch {
            detail = .failed(error.localizedDescription)
        }
    }
}
