import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class AppDetailViewModel {
    public private(set) var state: LoadingState<AppDetailResponse> = .idle
    public let appId: String

    private let client: any ScreensClient

    public init(appId: String, client: any ScreensClient) {
        self.appId = appId
        self.client = client
    }

    public func load() async {
        state = .loading
        do {
            let resp = try await client.appDetail(appId: appId)
            state = .loaded(resp)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
