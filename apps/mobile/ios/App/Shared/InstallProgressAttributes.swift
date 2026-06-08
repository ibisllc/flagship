import Foundation
import ActivityKit

/// Live Activity backing the create-server flow.
///
/// Five-step pipeline mirrors the SSE install-events the daemon emits
/// (packages/server-daemon/src/screens/screensHttp.ts): the user flashes
/// the personalized ISO, boots the box, the tunnel comes up, the cert
/// gets issued, and the server is live. We surface each transition as
/// a Live Activity update so the user sees progress on the Lock Screen
/// + Dynamic Island while they're flashing/booting the box and the
/// app is backgrounded.
///
/// `attributes` (immutable) carry the user-facing labels we set when
/// the activity is requested — the pod's display name + the issued
/// auth-code serial. `ContentState` is the dynamic per-update payload.
public struct InstallProgressAttributes: ActivityAttributes {

    public typealias ContentState = State

    public let serial: String
    public let podName: String

    public init(serial: String, podName: String) {
        self.serial = serial
        self.podName = podName
    }

    /// Ordered progress steps. Raw values double as SF Symbol names
    /// so the widget renders the right icon per stage without a
    /// switch. `failed` is terminal but carries a reason via
    /// State.failureReason.
    public enum Step: String, Codable, Sendable, CaseIterable {
        case started        // Installer started
        case partitioning   // Preparing disk
        case installing     // Installing the system
        case registered     // Phone-home received
        case boot           // OS booted
        case tunnelOnline   // Tunnel up
        case certIssued     // TLS cert issued
        case ready          // Server is live
        case failed         // Terminal — see failureReason

        public var label: String {
            switch self {
            case .started:      return "Installer started"
            case .partitioning: return "Preparing disk"
            case .installing:   return "Installing the system"
            case .registered:   return "Phone-home received"
            case .boot:         return "OS booted"
            case .tunnelOnline: return "Tunnel up"
            case .certIssued:   return "TLS cert issued"
            case .ready:        return "Server is live"
            case .failed:       return "Failed"
            }
        }

        public var systemImageName: String {
            switch self {
            case .started:      return "play.circle.fill"
            case .partitioning: return "internaldrive.fill"
            case .installing:   return "arrow.down.circle.fill"
            case .registered:   return "antenna.radiowaves.left.and.right"
            case .boot:         return "power"
            case .tunnelOnline: return "network"
            case .certIssued:   return "lock.fill"
            case .ready:        return "checkmark.seal.fill"
            case .failed:       return "exclamationmark.triangle.fill"
            }
        }
    }

    public struct State: Codable, Hashable, Sendable {
        public var currentStep: Step
        /// Steps that have already completed. Sorted Step.allCases
        /// order with `failed` excluded — the widget uses this to
        /// render the green-check / pending dot list.
        public var completedSteps: [Step]
        /// Non-nil once the SSE `ready` event arrives. Surfaces as a
        /// monospaced subtitle on the activity card.
        public var serverFqdn: String?
        /// Non-nil only when `currentStep == .failed`.
        public var failureReason: String?

        public init(
            currentStep: Step = .registered,
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
        /// completedSteps against the four non-terminal-success
        /// stages (registered → certIssued); reaches 1.0 only on
        /// `.ready`.
        public var fractionalProgress: Double {
            let major: [Step] = [.started, .partitioning, .installing, .registered, .boot, .tunnelOnline, .certIssued]
            if completedSteps.contains(.ready) { return 1.0 }
            let done = major.filter { completedSteps.contains($0) }.count
            return Double(done) / Double(major.count + 1)
        }
    }
}
