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
        // Only show the skeleton on the very first attempt. On retries and
        // pull-to-refresh, keep the current state (the "Connecting…" card or
        // the last-good detail) so a transient failure doesn't flash the
        // skeleton or wipe good data underneath the user.
        if case .idle = detail { detail = .loading }
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
            // Keep showing the last successful detail on a transient refresh
            // failure; only fall back to the "Connecting…" state when we never
            // had detail to begin with.
            if case .loaded = detail { return }
            detail = .failed(HumanError.humanize(error))
        }
    }
}
