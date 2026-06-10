import Foundation

/// Provision-timeline wire payload shared between the phone and the
/// watch. The iPhone composes one of these from whatever it knows about
/// the current install (push events, polled `ProvisionStatus`, or both)
/// and sends it via `WCSession.updateApplicationContext`. The watch sees
/// only the latest snapshot — same applicationContext semantics the
/// approvals flow uses.
///
/// Kept Codable + Foundation-only so both targets can encode it without
/// dragging in FlagshipAPI on the watch.
public extension WatchProtocol {
    struct ProvisionTimelineContext: Codable, Hashable, Sendable {
        /// Auth-code serial the install is bound to. Stable across the
        /// run; used as the cold-open id on the watch.
        public let serial: String
        /// Friendly pod name to title the watch surface.
        public let podName: String
        /// The eventual FQDN once the box has registered. Nil until
        /// `registering` lands.
        public let serverDomain: String?
        /// Latest `ProvisionStatusPhase.rawValue` — one of the 8-phase
        /// ladder rungs, or `error`, or `unknown` for forward-compat.
        public let phase: String
        /// Free-form latest detail (error text, percentage, etc.).
        public let detail: String?
        /// Append-only checkpoint history, oldest first.
        public let history: [PhaseEntry]
        public let updatedAt: Date
        /// False once the install reached a terminal phase AND the
        /// phone signalled the surface should clear. Lets the watch
        /// retain the last-known snapshot without rendering it as live.
        public let active: Bool

        public init(
            serial: String,
            podName: String,
            serverDomain: String?,
            phase: String,
            detail: String?,
            history: [PhaseEntry],
            updatedAt: Date,
            active: Bool
        ) {
            self.serial = serial
            self.podName = podName
            self.serverDomain = serverDomain
            self.phase = phase
            self.detail = detail
            self.history = history
            self.updatedAt = updatedAt
            self.active = active
        }

        public struct PhaseEntry: Codable, Hashable, Sendable {
            public let phase: String
            public let detail: String?
            public let ts: Int64
            public init(phase: String, detail: String?, ts: Int64) {
                self.phase = phase
                self.detail = detail
                self.ts = ts
            }
        }
    }

    /// Row in the rendered ladder.
    struct TimelineRow: Equatable, Sendable {
        public let phase: String
        public let title: String
        public let state: TimelineRowState
        public let detail: String?
        public init(phase: String, title: String, state: TimelineRowState, detail: String?) {
            self.phase = phase
            self.title = title
            self.state = state
            self.detail = detail
        }
    }

    enum TimelineRowState: String, Codable, Equatable, Sendable {
        case done, current, upcoming, error
    }

    /// Watch-side projection of `ProvisionTimelineContext` onto the
    /// rendered ladder. **Mirrors** the algorithm in the iPhone-side
    /// `FlagshipUI/ViewModels/ProvisionTimelineLadder` — the iPhone
    /// version is the spec (covered by `ProvisionTimelineLadderTests`);
    /// this one operates on the wire-type the watch receives so the
    /// FlagshipAPI/SwiftUI deps don't have to cross into the watch
    /// target.
    enum ProvisionTimelineLadder {
        /// The rendered ladder, in MONOTONIC wire order: `downloading` (the
        /// flagship software fetch) follows `installing`, and `installed`
        /// (ACTION-NEEDED — unplug the USB) is its own rung AFTER `sealing` (the
        /// final pre-poweroff checkpoint), matching the phone ladder exactly.
        public static let phases: [(phase: String, title: String)] = [
            ("booting",      "Booting"),
            ("partitioning", "Preparing disk"),
            ("installing",   "Installing"),
            ("downloading",  "Downloading system"),
            ("registering",  "Registering with Flagship"),
            ("sealing",      "Sealing your disk"),
            ("installed",    "Install complete — unplug the USB"),
            ("pairing",      "Pairing"),
            ("live",         "Server is live"),
        ]

        /// Mirrors `FlagshipCore.ProvisionTimelineLadder.installedUnplugDetail`.
        public static let installedUnplugDetail =
            "Install complete — unplug the USB, then power the box back on."

        public static func rows(for ctx: ProvisionTimelineContext?) -> [TimelineRow] {
            let ladder = phases
            let currentPhase = ctx?.phase

            if currentPhase == "error" {
                let brokeAt = ctx?.history.last(where: { $0.phase != "error" })?.phase
                let brokeIdx = brokeAt.flatMap { p in ladder.firstIndex(where: { $0.phase == p }) } ?? 0
                let err = errorDetail(in: ctx)
                return ladder.enumerated().map { i, entry in
                    if i < brokeIdx {
                        return TimelineRow(phase: entry.phase, title: entry.title, state: .done, detail: nil)
                    }
                    if i == brokeIdx {
                        return TimelineRow(phase: entry.phase, title: entry.title, state: .error, detail: err)
                    }
                    return TimelineRow(phase: entry.phase, title: entry.title, state: .upcoming, detail: nil)
                }
            }

            // No checkpoint or unknown phase → first row current with hint.
            guard let currentPhase,
                  !currentPhase.isEmpty,
                  let curIdx = ladder.firstIndex(where: { $0.phase == currentPhase })
            else {
                return ladder.enumerated().map { i, entry in
                    TimelineRow(
                        phase: entry.phase,
                        title: entry.title,
                        state: i == 0 ? .current : .upcoming,
                        detail: i == 0 ? "Waiting for the box to phone home…" : nil
                    )
                }
            }

            return ladder.enumerated().map { i, entry in
                if i < curIdx {
                    return TimelineRow(phase: entry.phase, title: entry.title, state: .done, detail: nil)
                }
                if i == curIdx {
                    let isLive = entry.phase == "live"
                    // `installed`: the box is OFF (nothing spins), but it's still
                    // the current action-needed rung carrying the unplug detail.
                    let detail = entry.phase == "installed"
                        ? installedUnplugDetail
                        : detailFor(entry.phase, in: ctx)
                    return TimelineRow(
                        phase: entry.phase,
                        title: entry.title,
                        state: isLive ? .done : .current,
                        detail: detail
                    )
                }
                return TimelineRow(phase: entry.phase, title: entry.title, state: .upcoming, detail: nil)
            }
        }

        private static func detailFor(_ phase: String, in ctx: ProvisionTimelineContext?) -> String? {
            if let d = ctx?.detail, !d.isEmpty { return d }
            let d = ctx?.history.last(where: { $0.phase == phase })?.detail
            return (d?.isEmpty ?? true) ? nil : d
        }

        private static func errorDetail(in ctx: ProvisionTimelineContext?) -> String? {
            let d = ctx?.detail ?? ctx?.history.last(where: { $0.phase == "error" })?.detail
            return (d?.isEmpty ?? true) ? nil : d
        }
    }

}
