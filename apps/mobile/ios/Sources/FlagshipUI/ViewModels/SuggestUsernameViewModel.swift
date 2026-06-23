import Foundation
import Observation
import FlagshipAPI

/// Backs SuggestUsernameScreen (the **create** path). Account creation hands the
/// user one random `<adjective>-<noun>` handle; the only edit affordance is a
/// regenerate button, rate-limited by an escalating per-device cooldown the
/// server returns as `retryAfterMs` (docs/username-suggestion-queue.md).
///
/// Takes a narrow `suggest` closure (not the whole client) so it's testable in
/// isolation. The screen wires it to `FlagshipServerClient.suggestUsername`.
@MainActor
@Observable
public final class SuggestUsernameViewModel {
    /// The currently-shown handle (nil until the first suggestion lands).
    public private(set) var current: String?
    public private(set) var loading: Bool = false
    /// Seconds left before the next regenerate is allowed (0 = ready).
    public private(set) var cooldownRemaining: Int = 0
    public private(set) var errorText: String?

    private let suggest: (String) async throws -> UsernameSuggestion
    private let deviceKey: String
    private var countdownTask: Task<Void, Never>?

    public init(
        deviceKey: String = SuggestUsernameViewModel.newDeviceKey(),
        suggest: @escaping (String) async throws -> UsernameSuggestion
    ) {
        self.deviceKey = deviceKey
        self.suggest = suggest
    }

    /// True iff the regenerate button should be tappable.
    public var canRegenerate: Bool { !loading && cooldownRemaining == 0 }
    /// True iff Continue should be enabled (we have a name to claim).
    public var canContinue: Bool { current != nil }

    /// Fetch the FIRST suggestion (idempotent — a no-op once we have one).
    public func load() async {
        guard current == nil else { return }
        await fetch()
    }

    /// Fetch a fresh suggestion; gated by the cooldown (the backend enforces it
    /// too, returning 429 — which we map to `throttled` and re-arm from).
    public func regenerate() async {
        guard canRegenerate else { return }
        await fetch()
    }

    private func fetch() async {
        loading = true
        errorText = nil
        defer { loading = false }
        do {
            let s = try await suggest(deviceKey)
            if let name = s.name, !s.throttled { current = name }
            armCooldown(ms: s.retryAfterMs)
        } catch {
            errorText = "Couldn't get a handle. Try again."
            armCooldown(ms: 2000)
        }
    }

    private func armCooldown(ms: Int) {
        countdownTask?.cancel()
        let secs = Int((Double(max(0, ms)) / 1000.0).rounded(.up))
        cooldownRemaining = secs
        guard secs > 0 else { return }
        countdownTask = Task { @MainActor [weak self] in
            while let self, self.cooldownRemaining > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                if self.cooldownRemaining > 0 { self.cooldownRemaining -= 1 }
            }
        }
    }

    /// A throwaway per-sign-up device id, just for the regenerate throttle.
    public nonisolated static func newDeviceKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in 0..<bytes.count { bytes[i] = UInt8.random(in: 0...255) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
