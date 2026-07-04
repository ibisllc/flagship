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

    /// Auto-pass `BiometricGate.evaluate` (the UI-level Face-ID consent
    /// prompts, e.g. the Settings → Add-a-device entry). The Simulator has no
    /// enrolled biometric, so those gates would make their screens unreachable
    /// in the gym. This bypass is UI-consent only — it emits NO crypto: any
    /// operation whose consent is load-bearing (keychain unseal, Secure-Enclave
    /// ECDH) still fails without the real ceremony, which is exactly why the
    /// gym stops at render/confirm stages. Set ONLY by the `-smoke-mode`
    /// launch seam.
    public nonisolated(unsafe) static var bypassBiometricGates = false
}
