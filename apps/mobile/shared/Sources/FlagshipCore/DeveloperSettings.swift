import Foundation
import Observation
import FlagshipAPI

/// Developer-only toggles. Persisted in UserDefaults so flipping them
/// survives launches without baking them into the build.
@Observable
@MainActor
public final class DeveloperSettings {
    private let defaults: UserDefaults
    private let useLiveKey = "flagship.dev.useLiveClient"
    private let revealedKey = "flagship.dev.unlocked"
    private let mockLatencyKey = "flagship.dev.mockLatencyMs"
    private let apexHostKey = "flagship.dev.apexHost"

    public var useLiveClient: Bool {
        didSet { defaults.set(useLiveClient, forKey: useLiveKey) }
    }

    /// Backend apex-host OVERRIDE (the gym test-build seam). Empty ⇒ prod
    /// default (`flagshipserver.com`). When set to e.g.
    /// `gym.flagshipserver.com`, every client retargets at the gym backend
    /// (and the data plane mirrors the `gym.` prefix). Persisted so a test
    /// build stays pointed at the gym across launches; PROD ships empty so
    /// `Endpoints` resolves to today's literal byte-for-byte. The launch-arg
    /// `-apex-host <host>` (see FlagshipApp) sets this before clients build.
    public var apexHost: String {
        didSet {
            defaults.set(apexHost, forKey: apexHostKey)
            DeveloperSettings.applyApexOverride(apexHost)
        }
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
        // On first launch the key is absent; default to the LIVE client
        // in EVERY build (owner request: the apps talk to a real pod out
        // of the box; the mock is opt-in via the 3-tap Developer toggle).
        // Once the user flips the toggle, the persisted value wins — so a
        // tester who taps over to mock stays on mock across launches.
        if defaults.object(forKey: useLiveKey) != nil {
            self.useLiveClient = defaults.bool(forKey: useLiveKey)
        } else {
            self.useLiveClient = DeveloperSettings.releaseDefaultUseLive
        }
        // GYM-ONLY: `-smoke-mode` scenarios are NO-BACKEND by contract — they
        // seed DemoFixtures and must render from the MOCK client (GymLiveTests
        // documents this split: live tests launch WITHOUT `-smoke-mode`).
        // Since `releaseDefaultUseLive` flipped to true (2026-06-19), a smoke
        // launch would otherwise ride the LIVE client with no session token —
        // every BFF read fails `noSessionToken` ("not paired" / "connection
        // expired"). Assigned in init, so `didSet` does NOT fire: the override
        // is in-memory only and never persists onto the simulator (a later
        // live-tier launch on the same simulator keeps its own default).
        // Production never passes `-smoke-mode`.
        if ProcessInfo.processInfo.arguments.contains("-smoke-mode") {
            self.useLiveClient = false
        }
        self.unlocked = defaults.bool(forKey: revealedKey)
        let raw = defaults.integer(forKey: mockLatencyKey)
        self.mockLatencyMs = raw == 0 ? 180 : raw
        self.apexHost = defaults.string(forKey: apexHostKey) ?? ""
        // Apply a persisted override at construction so a test build is
        // pointed at the gym backend before the first client is built. A
        // prod build has no persisted value ⇒ no override ⇒ prod default.
        DeveloperSettings.applyApexOverride(self.apexHost)
    }

    /// Install (or clear) the `Endpoints` override from an apex host. Empty /
    /// the prod host ⇒ clear (prod default). Shared by the launch-arg reader
    /// and the persisted-field path so there is one code path.
    public static func applyApexOverride(_ host: String) {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.isEmpty || trimmed == Endpoints.prodControlHost {
            Endpoints.setOverride(nil)
        } else {
            Endpoints.setOverride(controlHost: trimmed)
        }
    }

    /// Default for `useLiveClient` when the user has never touched the
    /// toggle. LIVE in every build (owner request 2026-06-19): the app
    /// targets a real pod out of the box. Flip to the mock via the 3-tap
    /// Developer section. Tests/the gym set the mode explicitly, so this
    /// default never decides their behavior. SwiftUI previews that need
    /// the mock construct their own mock-backed clients directly.
    public static let releaseDefaultUseLive: Bool = true
}
