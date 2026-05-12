import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class SettingsViewModel {
    public private(set) var tier: LoadingState<TierStatusResponse> = .idle

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func load() async {
        tier = .loading
        do {
            tier = .loaded(try await client.tierStatus())
        } catch {
            tier = .failed(error.localizedDescription)
        }
    }
}
