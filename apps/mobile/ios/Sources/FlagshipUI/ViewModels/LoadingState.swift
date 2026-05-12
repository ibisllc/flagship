import Foundation

/// Tri-state result for async screens. `idle` → first load not started.
/// `loading` → request in flight (UI shows skeleton/spinner). `loaded` →
/// data ready. `failed` → terminal error with a user-facing message.
public enum LoadingState<Value: Sendable>: Sendable {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    public var value: Value? {
        if case .loaded(let v) = self { return v } else { return nil }
    }

    public var isLoading: Bool {
        if case .loading = self { return true } else { return false }
    }

    public var failure: String? {
        if case .failed(let m) = self { return m } else { return nil }
    }
}
