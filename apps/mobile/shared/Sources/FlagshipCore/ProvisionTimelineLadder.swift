import Foundation
import FlagshipAPI

/// Pure projection of a `ProvisionStatus` onto the ordered ladder of
/// rendered rows. SwiftUI-free so it's unit-testable on its own, and so
/// the watchOS counterpart in `App/Shared/WatchProvisionTimeline.swift`
/// can mirror the algorithm against the wire-type the watch receives.
///
/// Driven by `ProvisionStatus.phase` + its append-only `history`. Before
/// the first checkpoint arrives (`status == nil`) the first row is
/// `.current` carrying a "waiting for the box to phone home" hint, so a
/// freshly-ordered pod still renders the ladder instead of a bare card.
/// On terminal `error`, the row owning the phase the box failed at (the
/// last non-error phase in history, else the first row) renders as
/// `.error` and carries the failure detail.
public enum ProvisionTimelineLadder {
    public enum RowState: Equatable, Sendable { case done, current, upcoming, error }

    public struct Row: Equatable, Sendable {
        public let phase: ProvisionStatusPhase
        public let state: RowState
        public let detail: String?
        public init(phase: ProvisionStatusPhase, state: RowState, detail: String?) {
            self.phase = phase
            self.state = state
            self.detail = detail
        }
    }

    /// Detail shown on the (now-green) `installing` row while the box sits in
    /// the powered-off `installed` gap. The single source for this copy across
    /// the phone ladder, the watch ladder, Android, and the webapp.
    public static let installedUnplugDetail =
        "Install complete — unplug the USB, then power the box back on."

    public static func rows(for status: ProvisionStatus?) -> [Row] {
        // `installed` is an ACTION-NEEDED checkpoint (the box finished the d-i
        // install, then powered OFF awaiting the user to unplug the USB + power
        // on) — NOT a rendered rung. We drop it from the visible ladder and
        // instead mark `installing` done (green tick, no spinner) carrying the
        // unplug instruction, so the checklist doesn't show a redundant spinning
        // "installed" step. (`ProvisionStatusPhase.ordered` still includes it so
        // the Live Activity / push surface the unplug prompt.)
        let ladder = ProvisionStatusPhase.ordered.filter { $0 != .installed }
        let currentPhase = status?.phase

        if currentPhase == .error {
            // The break can sit on `installed`; in the rendered ladder that
            // collapses onto `installing`.
            let rawBrokeAt = status?.history.last(where: { $0.phase != .error })?.phase ?? ladder.first
            let brokeAt = rawBrokeAt == .installed ? .installing : rawBrokeAt
            let brokeIdx = brokeAt.flatMap { ladder.firstIndex(of: $0) } ?? 0
            let err = errorDetail(in: status)
            return ladder.enumerated().map { i, phase in
                if i < brokeIdx { return Row(phase: phase, state: .done, detail: nil) }
                if i == brokeIdx { return Row(phase: phase, state: .error, detail: err) }
                return Row(phase: phase, state: .upcoming, detail: nil)
            }
        }

        // `installed`: the box is OFF, so nothing spins. Render `installing`
        // done with the unplug detail; everything after stays upcoming.
        if currentPhase == .installed {
            let installingIdx = ladder.firstIndex(of: .installing) ?? 0
            return ladder.enumerated().map { i, phase in
                if i < installingIdx { return Row(phase: phase, state: .done, detail: nil) }
                if i == installingIdx {
                    return Row(phase: phase, state: .done, detail: Self.installedUnplugDetail)
                }
                return Row(phase: phase, state: .upcoming, detail: nil)
            }
        }

        guard let currentPhase, let curIdx = ladder.firstIndex(of: currentPhase) else {
            return ladder.enumerated().map { i, phase in
                Row(
                    phase: phase,
                    state: i == 0 ? .current : .upcoming,
                    detail: i == 0 ? "Waiting for the box to phone home…" : nil
                )
            }
        }

        return ladder.enumerated().map { i, phase in
            if i < curIdx { return Row(phase: phase, state: .done, detail: nil) }
            if i == curIdx {
                let isLive = phase == .live
                return Row(
                    phase: phase,
                    state: isLive ? .done : .current,
                    detail: detailFor(phase, in: status)
                )
            }
            return Row(phase: phase, state: .upcoming, detail: nil)
        }
    }

    private static func detailFor(_ phase: ProvisionStatusPhase, in status: ProvisionStatus?) -> String? {
        if let d = status?.detail, !d.isEmpty { return d }
        let d = status?.history.last(where: { $0.phase == phase })?.detail
        return (d?.isEmpty ?? true) ? nil : d
    }

    private static func errorDetail(in status: ProvisionStatus?) -> String? {
        let d = status?.detail ?? status?.history.last(where: { $0.phase == .error })?.detail
        return (d?.isEmpty ?? true) ? nil : d
    }
}
