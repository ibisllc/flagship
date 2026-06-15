import Foundation
import Observation
import FlagshipAPI

/// Backs the dedicated tier-status / subscription screen (P7). Loads
/// `GET /api/screens/tier-status` and exposes the rendering-friendly
/// derivations the webapp `views/tier-status.js` computes inline.
@MainActor
@Observable
public final class TierStatusViewModel {
    public private(set) var state: LoadingState<TierStatusResponse> = .idle

    private let client: any ScreensClient

    public init(client: any ScreensClient) {
        self.client = client
    }

    public func load() async {
        state = .loading
        do {
            state = .loaded(try await client.tierStatus())
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Dispatcher usage progress, 0...100. Mirrors `pct(used, quota)` in
    /// tier-status.js: 0 when either is missing or quota is 0, else
    /// `min(100, round(used / quota * 100))`.
    public static func usagePercent(used: Double?, quota: Double?) -> Int {
        guard let used, let quota, quota != 0 else { return 0 }
        return min(100, Int((used / quota * 100).rounded()))
    }
}
