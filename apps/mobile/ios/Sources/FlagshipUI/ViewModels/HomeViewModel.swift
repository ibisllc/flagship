import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class HomeViewModel {
    public private(set) var detail: LoadingState<ServerDetailResponse> = .idle
    /// True when the LAST load failed because this device has no usable
    /// paired-session token. That includes both a missing local token and a 401
    /// from the box rejecting a stale token. The server-detail container reads
    /// this to surface the one-tap "Pair this server" affordance instead of the
    /// transient "Connecting…" placeholder (which would otherwise retry forever).
    public private(set) var needsPairing = false

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
            needsPairing = false
        } catch {
            // A missing OR box-rejected paired-session token is NOT transient —
            // retrying never helps until the owner pairs. A 403 is deliberately
            // excluded: it can be an operation-level authorization decision,
            // whereas the BFF's session gate reports an absent token as 401.
            switch error {
            case ScreensClientError.noSessionToken:
                needsPairing = true
            case ScreensClientError.http(status: 401, message: _):
                needsPairing = true
            default:
                needsPairing = false
            }
            // Keep showing the last successful detail on a transient refresh
            // failure; only fall back to the "Connecting…" state when we never
            // had detail to begin with.
            if case .loaded = detail { return }
            detail = .failed(HumanError.humanize(error))
        }
    }
}
