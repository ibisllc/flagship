#if DEBUG
import Foundation
import Observation

/// Gym-only: what the mock clients saw, readable by a UI test. Mocks note
/// each request worth checking ("signed server-order by admin-root",
/// "refused access-mode", "revoked browser session …"); a smoke-mode launch
/// shows the lines in an invisible `gym-probe` element whose accessibility
/// label a test reads. Notes are dropped outside `-smoke-mode`.
@MainActor
@Observable
public final class GymProbe {
    public static let shared = GymProbe()

    /// Newest last, at most `limit`.
    public private(set) var lines: [String] = []
    private let limit = 40

    public nonisolated static var isOn: Bool {
        ProcessInfo.processInfo.arguments.contains("-smoke-mode")
    }

    public nonisolated static func note(_ line: String) {
        guard isOn else { return }
        Task { @MainActor in shared.append(line) }
    }

    public func append(_ line: String) {
        lines.append(line)
        if lines.count > limit { lines.removeFirst(lines.count - limit) }
    }

    /// The accessibility label of the `gym-probe` element.
    public var label: String { lines.isEmpty ? "none" : lines.joined(separator: "\n") }
}
#endif
