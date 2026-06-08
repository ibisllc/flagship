import Foundation
import FlagshipAPI
import FlagshipCore

/// iPhone-side aggregator that publishes the current provision-timeline
/// context to the paired Watch via `WatchBridge` (which wraps
/// WCSession.updateApplicationContext).
///
/// Single canonical source: the per-order status channel
/// (`ProvisionStatus`, `ProvisionStatusPhase`). Two feed paths, both
/// canonical:
///   - Poll-driven (rich): when `PendingServerScreen` is open it polls
///     `fetchProvisionStatus` every 3s; the VM forwards each result to
///     `update(from:podName:)` (full history + serverDomain).
///   - Push-driven (sparse): a `provision-status` push surfaces the
///     latest `ProvisionStatusPhase` via `update(phase:serial:detail:
///     podName:)`, which appends to running history so the rail still
///     fills to the current rung when the app is backgrounded.
///
/// Either path updates the same shared context; whichever lands more
/// recently wins. The Watch sees only the latest snapshot.
@MainActor
final class WatchTimelinePublisher {
    static let shared = WatchTimelinePublisher()

    /// Currently-published context. Mirrored to WCSession's
    /// applicationContext on every `commit`.
    private(set) var current: WatchProtocol.ProvisionTimelineContext?

    private init() {}

    /// Update from a polled `ProvisionStatus` (rich source — full
    /// history, daemon-signed phases). Carries a friendly pod name so
    /// the watch surface has a title.
    func update(from status: ProvisionStatus, podName: String) {
        let history = status.history.map { entry in
            WatchProtocol.ProvisionTimelineContext.PhaseEntry(
                phase: entry.phase.rawValue,
                detail: entry.detail,
                ts: entry.ts
            )
        }
        let active: Bool
        switch status.phase {
        case .live, .error: active = false
        default:            active = true
        }
        let ctx = WatchProtocol.ProvisionTimelineContext(
            serial: status.serial,
            podName: podName,
            serverDomain: status.serverDomain ?? current?.serverDomain,
            phase: status.phase.rawValue,
            detail: status.detail,
            history: history,
            updatedAt: Date(timeIntervalSince1970: TimeInterval(status.updatedAt) / 1000),
            active: active
        )
        commit(ctx)
    }

    /// Update from a push-driven canonical phase (sparse source — latest
    /// `ProvisionStatusPhase` + optional detail). Appends to running
    /// history (keyed by the order serial) so the watch can still render
    /// the rail filled up to the current rung.
    func update(phase: ProvisionStatusPhase, serial: String, detail: String?, podName: String) {
        let raw = phase.rawValue
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        var history = current?.history ?? []
        // Skip a duplicate of the latest phase so repeated pushes for the
        // same phase don't pile up identical rows.
        if history.last?.phase != raw {
            history.append(.init(phase: raw, detail: detail, ts: nowMs))
        }
        let active = phase != .live && phase != .error
        let ctx = WatchProtocol.ProvisionTimelineContext(
            serial: serial,
            podName: podName,
            serverDomain: current?.serverDomain,
            phase: raw,
            detail: detail,
            history: history,
            updatedAt: Date(timeIntervalSince1970: TimeInterval(nowMs) / 1000),
            active: active
        )
        commit(ctx)
    }

    /// Clear the surface. Called on sign-out or after the user
    /// acknowledges a terminal install.
    func clear() {
        current = nil
        WatchBridge.shared.updateProvisionTimeline(nil)
    }

    private func commit(_ ctx: WatchProtocol.ProvisionTimelineContext) {
        current = ctx
        WatchBridge.shared.updateProvisionTimeline(ctx)
    }
}
