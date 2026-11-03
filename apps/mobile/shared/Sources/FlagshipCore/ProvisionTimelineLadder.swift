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
        String(localized: "Install complete. If it ran from a USB stick, unplug it and power the server back on.")

    /// `now` judges a box that went quiet (`ProvisionQuiet`); nil keeps the box's own detail.
    public static func rows(for status: ProvisionStatus?, now: Date? = nil) -> [Row] {
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
                    detail: i == 0 ? String(localized: "Waiting for the box to phone home…") : nil
                )
            }
        }

        let quiet: ProvisionQuiet = {
            guard let status, let now else { return .none }
            return ProvisionQuiet.of(phase: status.phase.rawValue, updatedAtMs: status.updatedAt, now: now)
        }()
        return ladder.enumerated().map { i, phase in
            if i < curIdx { return Row(phase: phase, state: .done, detail: nil) }
            if i == curIdx, let quietDetail = quiet.detail {
                return Row(phase: phase, state: .current, detail: quietDetail)
            }
            if i == curIdx {
                let isLive = phase == .live
                // `installed`: the box is powered off, so nothing spins — but it
                // is still the CURRENT rung (action needed) carrying the unplug
                // instruction. `live` is the terminal done state.
                // A hosted VM reports what it's doing on this rung ("Restarting
                // into the sealed disk"); a USB install reports nothing, so it
                // gets the unplug instruction.
                let detail = phase == .installed
                    ? (detailFor(phase, in: status) ?? Self.installedUnplugDetail)
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
        return (d?.isEmpty ?? true) ? nil : ProvisionProgress.failureDetail(d)
    }
}

/// What install progress says once the box goes quiet (packages/protocol/test-vectors/provision-quiet,
/// identical on Android and the webapp). The d-i installer reports at least every two minutes while it
/// runs, so an `installing` checkpoint older than five minutes means the installer has stopped; any
/// pre-registration checkpoint older than twenty minutes means the box stopped reporting before it
/// registered (home.serene-parrot, 2026-11-02: "Installing the bootloader" stayed up for an hour).
public enum ProvisionQuiet: Equatable, Sendable {
    case none, installerFinished, stuck

    public static let installerQuietAfterMs: Int64 = 5 * 60 * 1000
    public static let stuckAfterMs: Int64 = 20 * 60 * 1000
    public static let stuckPhases: Set<String> = [
        "booting", "partitioning", "installing", "downloading", "registering", "sealing",
    ]

    public static let installerFinishedDetail = String(localized: "The installer finished. The server is starting and should register in a few minutes.")
    public static let stuckDetail = String(localized: "This server stopped reporting and hasn't registered. It may be stuck.")
    public static let stuckAdvice = String(localized: "If it runs in Flagship Studio, look at it there. Otherwise restart the machine. If it still doesn't come up, cancel the order and create the server again.")

    public static func of(phase: String?, updatedAtMs: Int64, nowMs: Int64) -> ProvisionQuiet {
        guard let phase else { return .none }
        let quietMs = nowMs - updatedAtMs
        if stuckPhases.contains(phase), quietMs >= stuckAfterMs { return .stuck }
        if phase == "installing", quietMs >= installerQuietAfterMs { return .installerFinished }
        return .none
    }

    public static func of(phase: String?, updatedAtMs: Int64, now: Date) -> ProvisionQuiet {
        of(phase: phase, updatedAtMs: updatedAtMs, nowMs: Int64(now.timeIntervalSince1970 * 1000))
    }

    /// The current row's detail, or nil to keep the box's own.
    public var detail: String? {
        switch self {
        case .none: return nil
        case .installerFinished: return Self.installerFinishedDetail
        case .stuck: return Self.stuckDetail
        }
    }
}
