import Foundation
import Observation

/// App-wide toast queue. Views publish `info` / `success` / `warning` /
/// `error` messages through here; the `Toaster` overlay at the root of
/// ContentView renders the top-most one as a transient banner.
///
/// Toasts are de-duplicated by `id` so rapid identical publishes don't
/// stack. Auto-dismiss after `duration`; tap dismisses immediately.
@Observable
@MainActor
public final class ToastCenter {
    public private(set) var queue: [Toast] = []

    public init() {}

    public func info(_ message: String, duration: TimeInterval = 3) {
        publish(Toast(kind: .info, message: message, duration: duration))
    }
    public func success(_ message: String, duration: TimeInterval = 2.5) {
        publish(Toast(kind: .success, message: message, duration: duration))
    }
    public func warning(_ message: String, duration: TimeInterval = 4) {
        publish(Toast(kind: .warning, message: message, duration: duration))
    }
    public func error(_ message: String, duration: TimeInterval = 5) {
        publish(Toast(kind: .error, message: message, duration: duration))
    }

    public func dismiss(_ id: UUID) {
        queue.removeAll { $0.id == id }
    }

    private func publish(_ toast: Toast) {
        if queue.contains(where: { $0.kind == toast.kind && $0.message == toast.message }) {
            return
        }
        queue.append(toast)
        let id = toast.id
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(toast.duration * 1_000_000_000))
            await MainActor.run { self?.dismiss(id) }
        }
    }
}

public struct Toast: Identifiable, Equatable, Sendable {
    public enum Kind: Sendable { case info, success, warning, error }
    public let id: UUID
    public let kind: Kind
    public let message: String
    public let duration: TimeInterval
    public init(id: UUID = UUID(), kind: Kind, message: String, duration: TimeInterval) {
        self.id = id
        self.kind = kind
        self.message = message
        self.duration = duration
    }
}
