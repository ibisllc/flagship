#if DEBUG
import Foundation

/// GYM-ONLY static overrides (same pattern as
/// `SignOutPolicy.gymForceBlockNoRecovery`): seed states the UI gym needs that a
/// `-smoke-mode` demo session can't otherwise reach offline. Production never
/// flips these — the only writer is the smoke-mode launch seam in FlagshipApp
/// (iOS) / SmokeMode (Android twin), and a smoke launch is test-only by
/// construction.
public enum GymSeams {
    /// Treat THIS device as holding the admin master root (Slice D). A demo
    /// session never mints one (`Keystore.hasAdminRoot` is false without a real
    /// account-open ceremony), so the admin-gated surfaces — the Account-security
    /// "Rotate admin key" card and the add-device promote-to-admin toggle — would
    /// be unreachable in the no-backend gym. The gym asserts their RENDER +
    /// confirm stage only; it never fires a rotation/admit (which would fail on
    /// the absent real key — by design).
    public nonisolated(unsafe) static var forceAdminRoot = false

    /// How many server sessions this device holds, for the "does it hold a key
    /// that can still save a server's data?" check. The mock gym pairs
    /// sessions with its sample boxes, which says nothing about the scenario,
    /// so a smoke launch counts none unless `-smoke-server-session` asks for one.
    public nonisolated(unsafe) static var serverSessionCount: Int?

    /// Auto-pass `BiometricGate.evaluate` (the UI-level Face-ID consent
    /// prompts, e.g. the Settings → Add-a-device entry). The Simulator has no
    /// enrolled biometric, so those gates would make their screens unreachable
    /// in the gym. This bypass is UI-consent only — it emits NO crypto: any
    /// operation whose consent is load-bearing (keychain unseal, Secure-Enclave
    /// ECDH) still fails without the real ceremony, which is exactly why the
    /// gym stops at render/confirm stages. Set ONLY by the `-smoke-mode`
    /// launch seam.
    public nonisolated(unsafe) static var bypassBiometricGates = false

    /// Make every `BiometricGate.evaluate` end as if the person dismissed the
    /// prompt, so the gym can prove the destructive screens above the app lock
    /// (lock-screen Sign out, the update-required Sign out, removing a gone
    /// account) change nothing without the owner. Wins over the bypass. Set
    /// ONLY by `-smoke-refuse-biometric`.
    public nonisolated(unsafe) static var refuseBiometricGates = false

    /// Keep the app-wide "<App> wants to reach <host>" sheet from opening.
    /// The mock box always has a request waiting (Plants →
    /// tile.openstreetmap.org), so without this the sheet covers every smoke
    /// launch and nothing behind it can be tapped. `-smoke-access-alert`
    /// leaves it on for the scenario that answers it.
    public nonisolated(unsafe) static var suppressAccessAlerts = false

    /// A fixed account root (UMK) for the smoke session. A demo session has
    /// none in the keychain, so everything derived from it (the IRK, the
    /// sensitive-order key, free-AI requests) would throw before reaching
    /// the mock clients, which accept any signature. Set ONLY by the
    /// `-smoke-mode` seam; the onboarding walk creates real keys instead.
    public nonisolated(unsafe) static var accountRootSeed: Data?

    /// A fixed admin master root for a smoke session launched with
    /// `-smoke-admin-root`: this device then holds the admin root the mock
    /// `.com` and boxes pin, and signs sensitive orders with it as a real
    /// admin device does. Nil (the default) is a device without it, whose
    /// sensitive orders the mocks refuse, as the real ones do.
    public nonisolated(unsafe) static var adminRootSeed: Data?

    /// The admin root every smoke account pins (the mocks verify under it),
    /// whether or not this device holds it. Same key the Access control
    /// fixture signs admin orders with.
    public static let gymAdminRootSeed = Data(repeating: 9, count: 32)
}
#endif
