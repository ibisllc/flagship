import Foundation
import ActivityKit

/// Live Activity backing the create-server flow.
///
/// Driven by the SINGLE canonical provisioning channel
/// (`GET /api/order/<serial>/status`, `ProvisionStatusPhase`). The user
/// flashes the personalized ISO, the box boots, downloads, partitions,
/// installs, registers, seals its disk key, pairs, and goes live. We
/// surface each transition as a Live Activity update so the user sees
/// progress on the Lock Screen + Dynamic Island while the app is
/// backgrounded.
///
/// `Step` is the widget-extension-local twin of FlagshipAPI's
/// `ProvisionStatusPhase`: identical raw-string vocabulary
/// (`booting`…`live`/`error`), kept here as a self-contained enum because
/// the widget extension does not (and must not) link FlagshipAPI. The App
/// target bridges `ProvisionStatusPhase` → `Step` by raw value, so there
/// is exactly ONE phase vocabulary on the wire and across surfaces.
///
/// `attributes` (immutable) carry the user-facing labels we set when the
/// activity is requested — the pod's display name + the auth-code serial.
/// `ContentState` is the dynamic per-update payload.
public struct InstallProgressAttributes: ActivityAttributes {

    public typealias ContentState = State

    public let serial: String
    public let podName: String

    public init(serial: String, podName: String) {
        self.serial = serial
        self.podName = podName
    }

    /// Canonical provisioning ladder — raw values are byte-identical to
    /// `ProvisionStatusPhase.rawValue`. `error` is the terminal failure
    /// (carries a reason via `State.failureReason`).
    public enum Step: String, Codable, Sendable, CaseIterable {
        case booting
        case downloading
        case partitioning
        case installing
        case registering
        case sealing
        case pairing
        case live
        case error

        /// The happy-path ladder, in order, EXCLUDING the terminal
        /// `error`. Mirrors `ProvisionStatusPhase.ordered`.
        public static let ordered: [Step] = [
            .booting, .downloading, .partitioning, .installing,
            .registering, .sealing, .pairing, .live,
        ]

        /// Canonical phase title — byte-identical to
        /// `ProvisionStatusPhase.title` / provisionStatus.ts PHASE_TITLES.
        public var label: String {
            switch self {
            case .booting:      return "Booting up"
            case .downloading:  return "Downloading"
            case .partitioning: return "Partitioning disk"
            case .installing:   return "Installing"
            case .registering:  return "Registering with Flagship"
            case .sealing:      return "Sealing your disk key"
            case .pairing:      return "Pairing with your phone"
            case .live:         return "Your server is live"
            case .error:        return "Setup hit a problem"
            }
        }

        public var systemImageName: String {
            switch self {
            case .booting:      return "power"
            case .downloading:  return "arrow.down.circle.fill"
            case .partitioning: return "internaldrive.fill"
            case .installing:   return "shippingbox.fill"
            case .registering:  return "antenna.radiowaves.left.and.right"
            case .sealing:      return "lock.fill"
            case .pairing:      return "iphone.radiowaves.left.and.right"
            case .live:         return "checkmark.seal.fill"
            case .error:        return "exclamationmark.triangle.fill"
            }
        }
    }

    public struct State: Codable, Hashable, Sendable {
        public var currentStep: Step
        /// Steps that have already completed. Sorted Step.ordered order
        /// (`error` excluded) — the widget uses this to render the
        /// green-check / pending dot list.
        public var completedSteps: [Step]
        /// Non-nil once the `live` phase arrives. Surfaces as a
        /// monospaced subtitle on the activity card.
        public var serverFqdn: String?
        /// Non-nil only when `currentStep == .error`.
        public var failureReason: String?

        public init(
            currentStep: Step = .booting,
            completedSteps: [Step] = [],
            serverFqdn: String? = nil,
            failureReason: String? = nil
        ) {
            self.currentStep = currentStep
            self.completedSteps = completedSteps
            self.serverFqdn = serverFqdn
            self.failureReason = failureReason
        }

        /// Convenience: 0.0…1.0 progress for ProgressView. Counts
        /// completedSteps against the seven non-terminal-success stages
        /// (booting → pairing); reaches 1.0 only on `.live`.
        public var fractionalProgress: Double {
            let major: [Step] = [.booting, .downloading, .partitioning, .installing, .registering, .sealing, .pairing]
            if completedSteps.contains(.live) { return 1.0 }
            let done = major.filter { completedSteps.contains($0) }.count
            return Double(done) / Double(major.count + 1)
        }
    }
}
