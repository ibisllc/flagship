import Foundation
import FlagshipAPI

/// Provisioning progress projection for the demo "your server is being
/// installed" UI. Re-keyed onto the SINGLE canonical
/// `ProvisionStatusPhase` vocabulary (`booting`…`live`/`error`) + the
/// canonical UI group projection (design §1.2). The fraction, the group
/// labels, and the per-step states match the webapp + Android renderers
/// because all three derive from the same canonical phase ladder + group
/// table.
///
/// Phase strings here are `ProvisionStatusPhase.rawValue` — the demo
/// `DemoServerBlock.phase` carries canonical values (the Worker's
/// demoUsers.ts emits them now). `live` is terminal success; `error` is
/// terminal failure.
public enum ProvisionProgress {

    /// The happy-path ladder, in order, EXCLUDING the terminal `error`.
    /// Mirror of `ProvisionStatusPhase.ordered`.
    public static let ladder: [String] = ProvisionStatusPhase.ordered.map(\.rawValue)

    /// Canonical title per phase — sourced from `ProvisionStatusPhase`
    /// (provisionStatus.ts PHASE_TITLES). Includes the terminal `error`.
    public static let phaseTitles: [String: String] = {
        var m: [String: String] = [:]
        for p in ProvisionStatusPhase.allCases where p != .unknown {
            m[p.rawValue] = p.title
        }
        return m
    }()

    public enum StepKey: String, Sendable, Equatable {
        case booting, installing, registering, securing, ready
    }

    public struct StepGroup: Sendable, Equatable {
        public let key: StepKey
        public let label: String
        public let phases: [String]
    }

    /// The canonical UI groups, in order (design §1.2 projection table).
    public static let stepGroups: [StepGroup] = [
        StepGroup(key: .booting, label: "Booting",
                  phases: ["booting", "downloading", "partitioning"]),
        StepGroup(key: .installing, label: "Installing",
                  phases: ["installing"]),
        StepGroup(key: .registering, label: "Registering",
                  phases: ["registering", "pairing"]),
        StepGroup(key: .securing, label: "Securing",
                  phases: ["sealing"]),
        StepGroup(key: .ready, label: "Ready", phases: ["live"]),
    ]

    public enum StepState: String, Sendable, Equatable {
        case done, active, pending, failed
    }

    public struct StepView: Sendable, Equatable {
        public let key: StepKey
        public let label: String
        public let state: StepState
        /// Canonical phase title for the ACTIVE / FAILED group; nil
        /// otherwise.
        public let detail: String?
        public init(key: StepKey, label: String, state: StepState, detail: String?) {
            self.key = key
            self.label = label
            self.state = state
            self.detail = detail
        }
    }

    private static func isLadderPhase(_ p: String) -> Bool {
        ladder.contains(p)
    }

    /// Map a phase to a 0..1 fraction for a determinate progress bar.
    public static func fraction(_ phase: String?) -> Double {
        guard let phase, !phase.isEmpty else { return 0 }
        if phase == "live" { return 1 }
        if phase == "error" { return 0 }
        guard let idx = ladder.firstIndex(of: phase) else { return 0 }
        return Double(idx + 1) / Double(ladder.count)
    }

    private static func groupKey(forPhase phase: String) -> StepKey {
        for g in stepGroups where g.phases.contains(phase) { return g.key }
        return .booting
    }

    /// Project (phase, lastError, prevPhase) into the per-group checklist
    /// the demo install screen renders.
    public static func stepStates(
        phase: String?,
        lastError: String? = nil,
        prevPhase: String? = nil
    ) -> [StepView] {
        if phase == "live" {
            return stepGroups.map {
                StepView(key: $0.key, label: $0.label, state: .done, detail: nil)
            }
        }

        if phase == "error" {
            let failedPhase = (prevPhase.map(isLadderPhase) ?? false) ? prevPhase! : "booting"
            let failedGroup = groupKey(forPhase: failedPhase)
            let failedIdx = stepGroups.firstIndex { $0.key == failedGroup } ?? 0
            return stepGroups.enumerated().map { (i, g) in
                if i < failedIdx {
                    return StepView(key: g.key, label: g.label, state: .done, detail: nil)
                }
                if i == failedIdx {
                    let d = (lastError?.isEmpty ?? true) ? phaseTitles["error"] : lastError
                    return StepView(key: g.key, label: g.label, state: .failed, detail: d)
                }
                return StepView(key: g.key, label: g.label, state: .pending, detail: nil)
            }
        }

        guard let phase, isLadderPhase(phase) else {
            // No checkpoint yet → first group active, no detail.
            return stepGroups.enumerated().map { (i, g) in
                StepView(key: g.key, label: g.label, state: i == 0 ? .active : .pending, detail: nil)
            }
        }

        let activeGroup = groupKey(forPhase: phase)
        let activeIdx = stepGroups.firstIndex { $0.key == activeGroup } ?? 0
        return stepGroups.enumerated().map { (i, g) in
            if i < activeIdx {
                return StepView(key: g.key, label: g.label, state: .done, detail: nil)
            }
            if i == activeIdx {
                return StepView(key: g.key, label: g.label, state: .active, detail: phaseTitles[phase])
            }
            return StepView(key: g.key, label: g.label, state: .pending, detail: nil)
        }
    }

    /// Should the list (Home) render a thin progress bar for this demo
    /// server? True for any pre-`live` server; false for live / none /
    /// absent (those render as a normal online / empty row).
    public static func shouldShowProgressBar(phase: String?, status: String?) -> Bool {
        if status == "up", phase == nil || phase == "live" { return false }
        if phase == "live" { return false }
        if status == "none" { return false }
        return status == "provisioning" || phase != nil
    }
}
