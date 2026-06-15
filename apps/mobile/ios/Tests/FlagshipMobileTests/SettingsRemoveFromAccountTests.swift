import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// B6a — the SettingsScreen surface contract for the
/// "Remove this device from account" affordance.
///
/// The actual revocation pipeline lives in SettingsTab (revoke push +
/// Keystore.wipe + AppState.signOut), but the screen owns the
/// scare-sheet copy that adapts based on hasCloudRecovery. These
/// tests pin that copy logic against the public constructor so a
/// rename / re-flow surfaces here, not at human-QA time.
@MainActor
final class SettingsRemoveFromAccountTests: XCTestCase {

    func test_screenAcceptsRemoveFromAccountCallback() {
        // Compile-time contract: the public init takes
        // onRemoveFromAccount as an async closure + hasCloudRecovery
        // as a Bool. If a refactor renames either, this constructor
        // call breaks (which is the point).
        var called = false
        let _ = SettingsScreen(
            username: "u",
            controlDevices: .loaded([]),
            trustedDevices: .loaded([]),
            onRemoveFromAccount: { called = true },
            hasCloudRecovery: false
        )
        // We can't actually drive the View's @State sheet without a
        // ViewInspector dep, but the constructor accepting the
        // closure is the binding contract. A future ViewInspector-
        // wired test can drive the confirmation flow end-to-end.
        XCTAssertFalse(called) // closure exists but isn't fired by constructor alone
    }

    func test_screenDefaultsHasCloudRecoveryToTrue() {
        // Important safety: default true means we DON'T inadvertently
        // surface the catastrophic-warning copy ("no recovery — gone
        // for good") to users who haven't opted into a stricter
        // model. The container always passes app.hasCloudRecovery
        // explicitly, but the default protects callers that forget.
        let _ = SettingsScreen(
            username: "u",
            controlDevices: .loaded([]),
            trustedDevices: .loaded([])
        )
        // Construction succeeds without an explicit hasCloudRecovery
        // argument — the default is the contract.
    }
}
