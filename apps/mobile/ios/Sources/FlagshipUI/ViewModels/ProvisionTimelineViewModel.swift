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
/// Distinct from `PendingPodWatcher` (which polls the older
/// `/api/install-events/<serial>` channel to drive the Live Activity +
/// flip AppState). This view model is screen-scoped: it lives with the
/// `PendingServerScreen` and only feeds the in-screen timeline. The two
/// channels are independent on the Worker; the timeline reads the
/// per-order status channel keyed by the SAME serial.
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

    private let serial: String
    private let server: any FlagshipServerClient
    /// Nanoseconds between polls. Defaults to 3s in production; tests
    /// inject a tiny value to drive a multi-step progression fast.
    private let pollIntervalNanos: UInt64
    private var task: Task<Void, Never>?

    // The box's earliest signals (the d-i preseed beacons: booting /
    // partitioning / installing) land on the install-events channel, NOT on
    // the per-order status channel the bootstrap's report_phase posts to. We
    // poll both and merge so ANY signal advances the ladder.
    private var installCursor: Int = 0
    private var installFurthest: ProvisionStatusPhase?
    private var installDomain: String?

    private static func phase(forInstallEvent name: String) -> ProvisionStatusPhase? {
        switch name {
        case "d-i-started":       return .booting
        case "partitioning":      return .partitioning
        case "installer-running": return .installing
        case "registered":        return .registering
        case "ready":             return .live
        case "failed":            return .error
        default:                  return nil   // metrics:* and other non-ladder events
        }
    }

    private static func ladderIndex(_ p: ProvisionStatusPhase?) -> Int {
        guard let p else { return -1 }
        return ProvisionStatusPhase.ordered.firstIndex(of: p) ?? -1
    }

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
        // Channel 1 — per-order status (the bootstrap's report_phase). nil on a
        // 404 (no checkpoint yet) or a network blip.
        let order: ProvisionStatus? = (try? await server.fetchProvisionStatus(serial: serial)) ?? nil

        // Channel 2 — install-events (the d-i preseed beacons). Accumulate the
        // furthest ladder phase seen so an early signal lights up the bar even
        // before the bootstrap reports to the order channel.
        if let poll = try? await server.getInstallEvents(serial: serial, since: installCursor) {
            installCursor = poll.cursor
            for rec in poll.events {
                guard let ph = Self.phase(forInstallEvent: rec.eventName) else { continue }
                if ph == .error || Self.ladderIndex(ph) > Self.ladderIndex(installFurthest) {
                    installFurthest = ph
                }
                if rec.eventName == "ready", !rec.detail.isEmpty { installDomain = rec.detail }
            }
        }

        // Merge: a terminal error on either channel wins; otherwise take the
        // channel that's further along the ladder. order-status is preferred at
        // a tie (it carries serverDomain + history + per-step detail).
        let merged: ProvisionStatus?
        if order?.phase == .error || installFurthest == .error {
            merged = order ?? ProvisionStatus(serial: serial, serverDomain: installDomain,
                                              phase: .error, detail: nil, updatedAt: 0, history: [])
        } else if Self.ladderIndex(order?.phase) >= Self.ladderIndex(installFurthest) {
            merged = order
        } else if let installFurthest {
            merged = ProvisionStatus(
                serial: serial,
                serverDomain: order?.serverDomain ?? installDomain,
                phase: installFurthest,
                detail: nil,
                updatedAt: 0,
                history: order?.history ?? []
            )
        } else {
            merged = order
        }

        if let merged { status = merged }
        if let phase = merged?.phase, phase.isTerminal {
            isDone = true
            return true
        }
        return false
    }
}
