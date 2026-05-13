import Foundation
import Observation

/// Developer-only toggles. Persisted in UserDefaults so flipping them
/// survives launches without baking them into the build.
@Observable
@MainActor
public final class DeveloperSettings {
    private let defaults: UserDefaults
    private let useLiveKey = "flagship.dev.useLiveClient"
    private let revealedKey = "flagship.dev.unlocked"
    private let mockLatencyKey = "flagship.dev.mockLatencyMs"

    public var useLiveClient: Bool {
        didSet { defaults.set(useLiveClient, forKey: useLiveKey) }
    }

    /// "Developer" subsection in Settings is unlocked by 3-tapping the
    /// version row on AboutStub. Persists once unlocked so the user
    /// doesn't have to repeat the gesture.
    public var unlocked: Bool {
        didSet { defaults.set(unlocked, forKey: revealedKey) }
    }

    public var mockLatencyMs: Int {
        didSet { defaults.set(mockLatencyMs, forKey: mockLatencyKey) }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.useLiveClient = defaults.bool(forKey: useLiveKey)
        self.unlocked = defaults.bool(forKey: revealedKey)
        let raw = defaults.integer(forKey: mockLatencyKey)
        self.mockLatencyMs = raw == 0 ? 180 : raw
    }
}
