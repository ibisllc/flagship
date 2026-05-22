import Foundation

/// Provisioning progress model for the "your server is being installed"
/// UI. Swift mirror of packages/protocol/src/provisionProgress.ts — the
/// fraction, the four-group labels, and the per-step states must match
/// the webapp + Android renderers byte-for-byte (validated by the shared
/// phase ladder + the conformance tests).
public enum ProvisionProgress {

    /// The fine-grained ladder, in order, EXCLUDING the terminal
    /// `failed` phase. Mirror of PROVISION_PHASES minus `failed`.
    public static let ladder: [String] = [
        "boot",
        "cloned",
        "deps",
        "built",
        "identity",
        "registered",
        "tunnel-online",
        "acme-order",
        "dns01-publish-attempt",
        "dns01-publish-ok",
        "dns01-propagation-wait",
        "tlsalpn-served",
        "acme-validating",
        "cert-issued",
        "ready",
    ]

    /// Human title per fine-grained phase. Lockstep with the protocol's
    /// PROVISION_PHASE_TITLES + the control-plane push fan-out titles, so
    /// the in-app step copy matches the push the user just tapped.
    public static let phaseTitles: [String: String] = [
        "boot": "Server booting",
        "cloned": "Code cloned",
        "deps": "Installing dependencies",
        "built": "Build complete",
        "identity": "Identity generated",
        "registered": "Registered with Flagship",
        "tunnel-online": "Tunnel online",
        "acme-order": "Requesting certificate",
        "dns01-publish-attempt": "Publishing DNS challenge",
        "dns01-publish-ok": "DNS challenge published",
        "dns01-propagation-wait": "Waiting for DNS",
        "tlsalpn-served": "Serving TLS challenge",
        "acme-validating": "Validating certificate",
        "cert-issued": "TLS certificate issued",
        "ready": "Server is live",
        "failed": "Provisioning failed",
    ]

    public enum StepKey: String, Sendable, Equatable {
        case booting, registering, securing, ready
    }

    public struct StepGroup: Sendable, Equatable {
        public let key: StepKey
        public let label: String
        public let phases: [String]
    }

    /// The four user-facing groups, in order.
    public static let stepGroups: [StepGroup] = [
        StepGroup(key: .booting, label: "Booting",
                  phases: ["boot", "cloned", "deps", "built", "identity"]),
        StepGroup(key: .registering, label: "Registering",
                  phases: ["registered", "tunnel-online"]),
        StepGroup(key: .securing, label: "Securing (TLS certificate)",
                  phases: [
                    "acme-order",
                    "dns01-publish-attempt",
                    "dns01-publish-ok",
                    "dns01-propagation-wait",
                    "tlsalpn-served",
                    "acme-validating",
                    "cert-issued",
                  ]),
        StepGroup(key: .ready, label: "Ready", phases: ["ready"]),
    ]

    public enum StepState: String, Sendable, Equatable {
        case done, active, pending, failed
    }

    public struct StepView: Sendable, Equatable {
        public let key: StepKey
        public let label: String
        public let state: StepState
        /// Fine-grained phase title for the ACTIVE / FAILED group; nil
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
        if phase == "ready" { return 1 }
        if phase == "failed" { return 0 }
        guard let idx = ladder.firstIndex(of: phase) else { return 0 }
        return Double(idx + 1) / Double(ladder.count)
    }

    private static func groupKey(forPhase phase: String) -> StepKey {
        for g in stepGroups where g.phases.contains(phase) { return g.key }
        return .booting
    }

    /// Project (phase, lastError, prevPhase) into the per-group checklist
    /// every detail page renders. See the protocol module for the rules.
    public static func stepStates(
        phase: String?,
        lastError: String? = nil,
        prevPhase: String? = nil
    ) -> [StepView] {
        if phase == "ready" {
            return stepGroups.map {
                StepView(key: $0.key, label: $0.label, state: .done, detail: nil)
            }
        }

        if phase == "failed" {
            let failedPhase = (prevPhase.map(isLadderPhase) ?? false) ? prevPhase! : "boot"
            let failedGroup = groupKey(forPhase: failedPhase)
            let failedIdx = stepGroups.firstIndex { $0.key == failedGroup } ?? 0
            return stepGroups.enumerated().map { (i, g) in
                if i < failedIdx {
                    return StepView(key: g.key, label: g.label, state: .done, detail: nil)
                }
                if i == failedIdx {
                    let d = (lastError?.isEmpty ?? true) ? phaseTitles["failed"] : lastError
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
    /// server? True for any pre-`ready` server; false for ready / none /
    /// absent (those render as a normal online / empty row).
    public static func shouldShowProgressBar(phase: String?, status: String?) -> Bool {
        if status == "up", phase == nil || phase == "ready" { return false }
        if phase == "ready" { return false }
        if status == "none" { return false }
        return status == "provisioning" || phase != nil
    }
}
