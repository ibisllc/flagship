import XCTest
@testable import FlagshipCore

/// B12 — pure-logic tests for the lock-screen state machine.
/// BiometricGate itself (LAContext evaluatePolicy) needs a UI test
/// to actually exercise the prompt; these tests cover AppState's
/// latch behavior and PrivacySettings persistence.
@MainActor
final class BiometricGateLogicTests: XCTestCase {

    func test_defaultRequireBiometricIsFalse() {
        // Important safety: opt-in, not opt-out. First-launch users
        // are NOT locked out before they've seen the option.
        let s = AppState()
        XCTAssertFalse(s.requireBiometricAtLaunch)
    }

    func test_defaultIsUnlockedTrue_whenRequireIsFalse() {
        // If biometric isn't required, the runtime latch starts true
        // so content renders immediately.
        let s = AppState(requireBiometricAtLaunch: false)
        XCTAssertTrue(s.isUnlocked)
    }

    func test_defaultIsUnlockedFalse_whenRequireIsTrue() {
        // If biometric IS required, latch starts false → lock screen
        // shows on launch.
        let s = AppState(requireBiometricAtLaunch: true)
        XCTAssertFalse(s.isUnlocked)
    }

    func test_explicitIsUnlockedOverridesDefault() {
        // Hydrating from a "user was already unlocked when we paused"
        // resume state.
        let s = AppState(requireBiometricAtLaunch: true, isUnlocked: true)
        XCTAssertTrue(s.isUnlocked)
    }

    func test_markUnlocked_flipsLatchToTrue() {
        let s = AppState(requireBiometricAtLaunch: true)
        XCTAssertFalse(s.isUnlocked)
        s.markUnlocked()
        XCTAssertTrue(s.isUnlocked)
    }

    func test_relockForBackground_noOpsWhenNotRequired() {
        let s = AppState(requireBiometricAtLaunch: false)
        XCTAssertTrue(s.isUnlocked)
        s.relockForBackground()
        XCTAssertTrue(s.isUnlocked) // unchanged — gate wasn't armed
    }

    func test_relockForBackground_flipsLatchWhenRequired() {
        let s = AppState(requireBiometricAtLaunch: true, isUnlocked: true)
        XCTAssertTrue(s.isUnlocked)
        s.relockForBackground()
        XCTAssertFalse(s.isUnlocked)
    }

    func test_signOut_dropsLatchToUnlocked() {
        // Welcome screen never needs the gate (the user's about to
        // authenticate via passkey anyway), so signOut releases.
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            requireBiometricAtLaunch: true,
            isUnlocked: false
        )
        s.signOut()
        XCTAssertTrue(s.isUnlocked)
        // Preference itself stays — next launch with isPaired true
        // again will re-arm the gate.
        XCTAssertTrue(s.requireBiometricAtLaunch)
    }

    func test_privacySettings_roundTripsThroughUserDefaults() {
        let suite = UserDefaults(suiteName: "test-\(UUID().uuidString)")!
        let p1 = PrivacySettings(defaults: suite)
        XCTAssertFalse(p1.requireBiometricAtLaunch)
        p1.requireBiometricAtLaunch = true
        // New instance same suite — verifies the didSet writer.
        let p2 = PrivacySettings(defaults: suite)
        XCTAssertTrue(p2.requireBiometricAtLaunch)
    }
}
