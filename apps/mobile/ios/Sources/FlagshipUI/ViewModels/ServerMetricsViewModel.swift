import Foundation
import Observation
import FlagshipAPI

@Observable
@MainActor
public final class ServerMetricsViewModel {
    public private(set) var state: LoadingState<ServerMetricsResponse> = .idle
    public let podId: String

    private let client: any ScreensClient
    private var pollTask: Task<Void, Never>?

    public init(podId: String, client: any ScreensClient) {
        self.podId = podId
        self.client = client
    }


    public func load() async {
        state = .loading
        do {
            state = .loaded(try await client.serverMetrics(podId: podId))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Poll the metrics endpoint every `interval` seconds. Live impls
    /// would prefer SSE/WS; until then this gives a "live-ish" feel.
    public func startPolling(every interval: TimeInterval = 15) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            await self?.load()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                if Task.isCancelled { return }
                await self?.load()
            }
        }
    }

    public func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }
}
