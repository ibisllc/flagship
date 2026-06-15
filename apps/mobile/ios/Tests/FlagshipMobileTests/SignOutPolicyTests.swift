import XCTest
import SwiftUI
@testable import FlagshipCore
@testable import FlagshipUI

/// #52 — the Tier-2 sign-out gate. A Tier-2 sign-out wipes this device's
/// local key material; on an account with NO cloud recovery that key is the
/// ONLY copy of the identity, so the wipe orphans the account (and a later
/// sign-in re-pairs under a brand-new IRK — observed live 2026-06-09).
/// SignOutPolicy is the single decision point the UI (SettingsScreen
/// dialog) AND the action layer (SettingsTab onSignOut closure) both
/// evaluate, so no code path can wipe the only key.
final class SignOutPolicyTests: XCTestCase {

    // ─── The decision matrix ────────────────────────────────────────────

    func test_allowed_whenCloudRecoveryEnrolled() {
        XCTAssertEqual(
            SignOutPolicy.evaluate(hasCloudRecovery: true, isDemoAccount: false),
            .allowed
        )
    }

    func test_blocked_whenNoCloudRecovery() {
        XCTAssertEqual(
            SignOutPolicy.evaluate(hasCloudRecovery: false, isDemoAccount: false),
            .blockedNoRecovery,
            "without recovery the local key is the only copy — sign-out must be blocked"
        )
    }

    /// Demo/mock sessions never wrap a real UMK — nothing of value is lost
    /// on wipe, and sign-out is the routine way to leave the sandbox.
    func test_demoAccount_isExempt_evenWithoutRecovery() {
        XCTAssertEqual(
            SignOutPolicy.evaluate(hasCloudRecovery: false, isDemoAccount: true),
            .allowed
        )
    }

    func test_demoAccount_withRecovery_stillAllowed() {
        XCTAssertEqual(
            SignOutPolicy.evaluate(hasCloudRecovery: true, isDemoAccount: true),
            .allowed
        )
    }

    /// Default for the demo flag is fail-closed: omitting it must behave
    /// exactly like a real (non-demo) account.
    func test_defaultIsNotDemo() {
        XCTAssertEqual(SignOutPolicy.evaluate(hasCloudRecovery: false), .blockedNoRecovery)
        XCTAssertEqual(SignOutPolicy.evaluate(hasCloudRecovery: true), .allowed)
    }

    // ─── The action-layer guard (the exact pipeline SettingsTab runs) ───

    /// Mirrors SettingsTab.onSignOut: guard on the policy BEFORE the wipe.
    /// Blocked ⇒ the wipe + signOut must be unreachable.
    @MainActor
    func test_actionLayerGuard_blocked_neverWipesOrSignsOut() {
        let app = AppState(isPaired: true, currentUser: "alice", hasCloudRecovery: false)
        var wiped = false

        func onSignOut() {
            guard SignOutPolicy.evaluate(
                hasCloudRecovery: app.hasCloudRecovery,
                isDemoAccount: false
            ) == .allowed else { return }
            wiped = true
            app.signOut()
        }
        onSignOut()

        XCTAssertFalse(wiped, "the guard must make the key wipe unreachable")
        XCTAssertTrue(app.isPaired, "the session must survive a blocked sign-out")
        XCTAssertEqual(app.currentUser, "alice")
    }

    @MainActor
    func test_actionLayerGuard_allowed_proceeds() {
        let app = AppState(isPaired: true, currentUser: "alice", hasCloudRecovery: true)
        var wiped = false

        func onSignOut() {
            guard SignOutPolicy.evaluate(
                hasCloudRecovery: app.hasCloudRecovery,
                isDemoAccount: false
            ) == .allowed else { return }
            wiped = true
            app.signOut()
        }
        onSignOut()

        XCTAssertTrue(wiped)
        XCTAssertFalse(app.isPaired)
        XCTAssertNil(app.currentUser)
    }

    @MainActor
    func test_actionLayerGuard_demoExemption_proceedsWithoutRecovery() {
        let app = AppState(isPaired: true, currentUser: "demo", hasCloudRecovery: false)
        var wiped = false

        func onSignOut() {
            guard SignOutPolicy.evaluate(
                hasCloudRecovery: app.hasCloudRecovery,
                isDemoAccount: true // !dev.useLiveClient — the mock/demo client
            ) == .allowed else { return }
            wiped = true
            app.signOut()
        }
        onSignOut()

        XCTAssertTrue(wiped, "demo sessions never wrap a real UMK — sign-out stays routine")
        XCTAssertFalse(app.isPaired)
    }

    // ─── Screen wiring (constructor contract) ───────────────────────────

    @MainActor
    func test_settingsScreenAcceptsSignOutPolicy() {
        var openedRecovery = false
        let _ = SettingsScreen(
            username: "u",
            tier: .idle,
            controlDevices: .loaded([]),
            trustedDevices: .loaded([]),
            onSignOut: { XCTFail("a blocked screen must never be handed a live wipe") },
            onOpenRecovery: { openedRecovery = true },
            hasCloudRecovery: false,
            signOutPolicy: .blockedNoRecovery
        )
        // Constructor wiring is the contract; the blocked dialog's primary
        // action fires onOpenRecovery (not driven here without ViewInspector).
        XCTAssertFalse(openedRecovery)
    }
}
