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

    /// Detail shown on the `installed` row while the box sits in the
    /// powered-off `installed` gap (it has registered + sealed, then powered
    /// off awaiting the user). The single source for this copy across the
    /// phone ladder, the watch ladder, Android, and the webapp.
    public static let installedUnplugDetail =
        "Install complete — unplug the USB, then power the box back on."

    public static func rows(for status: ProvisionStatus?) -> [Row] {
        // `installed` is now a REAL visible rung — the final pre-poweroff
        // checkpoint (the box finished the install, registered, sealed, then
        // powered OFF awaiting the user to unplug the USB + power on). It sits
        // after `sealing` in `ProvisionStatusPhase.ordered`. When it's the
        // current phase the box is OFF (nothing spins), so its row renders
        // `.current` carrying the unplug instruction.
        let ladder = ProvisionStatusPhase.ordered
        let currentPhase = status?.phase

        if currentPhase == .error {
            let brokeAt = status?.history.last(where: { $0.phase != .error })?.phase ?? ladder.first
            let brokeIdx = brokeAt.flatMap { ladder.firstIndex(of: $0) } ?? 0
            let err = errorDetail(in: status)
            return ladder.enumerated().map { i, phase in
                if i < brokeIdx { return Row(phase: phase, state: .done, detail: nil) }
                if i == brokeIdx { return Row(phase: phase, state: .error, detail: err) }
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
                // `installed`: the box is powered off, so nothing spins — but it
                // is still the CURRENT rung (action needed) carrying the unplug
                // instruction. `live` is the terminal done state.
                let detail = phase == .installed
                    ? Self.installedUnplugDetail
                    : detailFor(phase, in: status)
                return Row(
                    phase: phase,
                    state: isLive ? .done : .current,
                    detail: detail
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
