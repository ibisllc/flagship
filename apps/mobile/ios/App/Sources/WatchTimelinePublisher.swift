import Foundation
import FlagshipAPI
import FlagshipCore

/// iPhone-side aggregator that publishes the current provision-timeline
/// context to the paired Watch via `WatchBridge` (which wraps
/// WCSession.updateApplicationContext).
///
/// Sources:
///   - Push-driven: `ProvisionPhaseBridge.onPhase` (always running while
///     the iPhone is foregrounded; fine-grained wire phases get folded
///     onto the 8-phase ladder).
///   - Poll-driven: when `PendingServerScreen` is open it polls
///     `fetchProvisionStatus` every 3s; that path can call
///     `update(from:podName:)` to forward the richer history.
///
/// Either source updates the same shared context; whichever lands more
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

    /// Update from a push-driven phase event (sparse source — latest
    /// phase + maybe error). Folds the wire phase onto the ladder and
    /// appends to running history so the watch can still render the
    /// rail filled up to the current rung.
    func update(from event: ProvisionPhaseEvent, podName: String, serial: String) {
        let mapped = WatchProtocol.ProvisionPhaseMapping.map(event.phase)
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        var history = current?.history ?? []
        // Skip a duplicate of the latest phase so repeated `boot` push
        // events don't pile up identical rows.
        if history.last?.phase != mapped {
            history.append(.init(phase: mapped, detail: event.error, ts: nowMs))
        }
        let active = mapped != "live" && mapped != "error"
        let serverDomain: String? = {
            if !event.fqdn.isEmpty { return event.fqdn }
            return current?.serverDomain
        }()
        let ctx = WatchProtocol.ProvisionTimelineContext(
            serial: serial,
            podName: podName,
            serverDomain: serverDomain,
            phase: mapped,
            detail: event.error,
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
