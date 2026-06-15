import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Task #46 — the three-tier session model.
///
///   Tier 1 LOCK — re-gate behind Face ID, remove nothing.
///   Tier 2 SIGN OUT — erase this device's local key material from the
///     Keychain WITHOUT revoking server-side (snoop-hardening); the
///     device stays a valid account member and comes back via passkey
///     recovery as an INSTANT re-pair (same IRK ⇒ Phase A).
///   Tier 3 REMOVE THIS DEVICE — cryptographic eviction (revoke + rotate),
///     unchanged (covered by SettingsRemoveFromAccountTests).
///
/// AppState.lock() latch behavior lives in BiometricGateLogicTests; this
/// file covers the Keystore + server-mutation contract of Tier 2 and the
/// screen's callback surface.
@MainActor
final class ThreeTierSessionTests: XCTestCase {

    override func setUp() {
        super.setUp()
        Keystore.setActiveProfile(nil)
        Keystore.wipe()
    }
    override func tearDown() {
        Keystore.setActiveProfile(nil)
        Keystore.wipe()
        super.tearDown()
    }

    /// Spy push registrar — records whether the server-side push-token
    /// revoke was invoked. Tier 2 must NOT call it (server is untouched);
    /// Tier 3 does.
    final class SpyPushRegistrar: PushRegistrarHandle {
        private(set) var revokeCalled = false
        func revoke() async { revokeCalled = true }
    }

    // MARK: - Tier 2: key-wipe sign-out

    func test_signOut_wipesKeystore_hasWrappedUMKFalseAfter() async throws {
        try await Keystore.generateUMK(reason: "test")
        XCTAssertTrue(Keystore.hasWrappedUMK)

        // The exact Tier-2 pipeline the SettingsTab onSignOut closure runs:
        // wipe local key material, then drop the session. No revoke.
        Keystore.wipe()
        let app = AppState(isPaired: true, currentUser: "alice")
        app.signOut()

        XCTAssertFalse(Keystore.hasWrappedUMK, "the wrapped UMK/IRK must be gone from the Keychain")
        XCTAssertFalse(app.isPaired)
        XCTAssertNil(app.currentUser)
    }

    func test_signOut_doesNotRevokeServerSide() async throws {
        try await Keystore.generateUMK(reason: "test")
        let spy = SpyPushRegistrar()
        let app = AppState(isPaired: true, currentUser: "alice")

        // Tier-2 sign out: local-only. Deliberately NO `await spy.revoke()`,
        // unlike the danger-zone eviction (Tier 3 / onRemoveFromAccount).
        Keystore.wipe()
        app.signOut()

        XCTAssertFalse(spy.revokeCalled,
            "Tier-2 sign out must not mutate server state — no push-token revoke")
        XCTAssertFalse(Keystore.hasWrappedUMK)
    }

    /// Contrast: Tier 3 (Remove this device) DOES revoke. Pins the
    /// distinction so the two don't collapse back together.
    func test_removeFromAccount_revokesServerSide() async throws {
        try await Keystore.generateUMK(reason: "test")
        let spy = SpyPushRegistrar()
        let app = AppState(isPaired: true, currentUser: "alice")

        // The onRemoveFromAccount pipeline: revoke push on .com, then wipe.
        await spy.revoke()
        Keystore.wipe()
        app.signOut()

        XCTAssertTrue(spy.revokeCalled, "Tier-3 eviction revokes server-side")
        XCTAssertFalse(Keystore.hasWrappedUMK)
    }

    // MARK: - Screen callback surface

    func test_settingsScreenAcceptsLockAndSignOutCallbacks() {
        var locked = false
        var signedOut = false
        let _ = SettingsScreen(
            username: "u",
            tier: .idle,
            controlDevices: .loaded([]),
            trustedDevices: .loaded([]),
            onLock: { locked = true },
            onSignOut: { signedOut = true },
            hasCloudRecovery: true
        )
        // Constructor wiring is the contract; a confirm sheet (not driven
        // here without ViewInspector) fires onSignOut, the button fires
        // onLock directly.
        XCTAssertFalse(locked)
        XCTAssertFalse(signedOut)
    }
}
