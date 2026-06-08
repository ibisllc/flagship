import Foundation
import Observation
import FlagshipAPI

/// Polls flagshipserver.com `GET /api/order/<serial>/status` (~every 3s)
/// for a pending pod's auth-code serial and surfaces the latest
/// `ProvisionStatus` so the timeline view can render real install
/// progress. Polling stops on the terminal `live` / `error` phase (or
/// after a soft 1-hour cap so an abandoned install eventually stops
/// burning battery).
///
/// This is the SINGLE canonical channel — the box reports every phase
/// (`booting`…`live`/`error`) exactly once to the per-order status
/// endpoint and every iOS surface reads from here. The earlier
/// install-events dual-channel merge has been retired.
@MainActor
@Observable
public final class ProvisionTimelineViewModel {
    /// 3 seconds between polls (per the task contract). `nonisolated` so the
    /// `init` default-argument expression (evaluated at the caller, which may
    /// be nonisolated) can read it without a main-actor hop — safe because it's
    /// an immutable Sendable constant, not main-actor state.
    public nonisolated static let pollInterval: UInt64 = 3_000_000_000
    /// Soft cap: stop polling an abandoned install after an hour. `nonisolated`
    /// for the same reason — a pure timing constant, not isolated state.
    public nonisolated static let watchTimeout: UInt64 = 60 * 60_000_000_000

    /// The latest status the Worker returned, or nil before the first
    /// checkpoint arrives (the box hasn't phoned home yet — a 404).
    public private(set) var status: ProvisionStatus?
    /// True once a terminal phase (`live` / `error`) has been observed;
    /// the poller has stopped.
    public private(set) var isDone: Bool = false

    /// Convenience: the latest phase, defaulting to nil before any poll.
    public var phase: ProvisionStatusPhase? { status?.phase }

    /// Called with the freshest status after every successful poll, so a
    /// host (the App target) can mirror it onto the Watch timeline. nil
    /// in previews/tests so the VM stays side-effect-free there.
    public var onStatus: ((ProvisionStatus) -> Void)?

    private let serial: String
    private let server: any FlagshipServerClient
    /// Nanoseconds between polls. Defaults to 3s in production; tests
    /// inject a tiny value to drive a multi-step progression fast.
    private let pollIntervalNanos: UInt64
    private var task: Task<Void, Never>?

    public init(
        serial: String,
        server: any FlagshipServerClient,
        pollIntervalNanos: UInt64 = ProvisionTimelineViewModel.pollInterval
    ) {
        self.serial = serial
        self.server = server
        self.pollIntervalNanos = pollIntervalNanos
    }

    public func start() {
        stop()
        isDone = false
        let startedAt = DispatchTime.now().uptimeNanoseconds
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if DispatchTime.now().uptimeNanoseconds - startedAt > Self.watchTimeout {
                    return
                }
                let terminal = await self.pollOnce()
                if terminal { return }
                try? await Task.sleep(nanoseconds: self.pollIntervalNanos)
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    /// One poll round-trip. Returns true if a terminal phase was
    /// observed so the loop can return without sleeping.
    private func pollOnce() async -> Bool {
        // The single canonical channel — per-order status (every phase the
        // box reports, once each). nil on a 404 (no checkpoint yet) or a
        // network blip; we just try again next tick.
        guard let next = (try? await server.fetchProvisionStatus(serial: serial)) ?? nil else {
            return false
        }
        status = next
        onStatus?(next)
        if next.phase.isTerminal {
            isDone = true
            return true
        }
        return false
    }
}
