import XCTest
@testable import FlagshipUI

/// Covers the **Secure your account** onboarding step's selection +
/// skip-confirmation state machine and its iCloud-availability gating.
///
///   - cloud available → cloud pre-selected,
///   - cloud off → nothing pre-selected, but file + skip still work,
///   - skip → the warning (confirmation) is surfaced.
@MainActor
final class SecureAccountViewModelTests: XCTestCase {

    func test_cloudAvailable_preselectsCloud() {
        let vm = SecureAccountViewModel(iCloudAvailable: true)
        XCTAssertEqual(vm.selected, .cloud, "cloud is pre-selected when iCloud is available")
        XCTAssertTrue(vm.canSelectCloud)
        XCTAssertTrue(vm.canContinue, "Continue is enabled with the pre-selection")
    }

    func test_cloudOff_preselectsNothing_andCloudNotSelectable() {
        let vm = SecureAccountViewModel(iCloudAvailable: false)
        XCTAssertNil(vm.selected, "nothing is pre-selected when iCloud is off")
        XCTAssertFalse(vm.canSelectCloud)
        XCTAssertFalse(vm.canContinue, "Continue is disabled until the user picks file")

        // Selecting cloud is a no-op when it isn't available.
        vm.selectCloud()
        XCTAssertNil(vm.selected, "cloud stays unselected when iCloud is off")
    }

    func test_cloudOff_fileStillWorks() {
        let vm = SecureAccountViewModel(iCloudAvailable: false)
        vm.selectFile()
        XCTAssertEqual(vm.selected, .file)
        XCTAssertTrue(vm.canContinue, "the file path keeps the step usable when iCloud is off")
    }

    func test_cloudOff_skipStillWorks() {
        let vm = SecureAccountViewModel(iCloudAvailable: false)
        XCTAssertFalse(vm.showSkipConfirm)
        vm.requestSkip()
        XCTAssertTrue(vm.showSkipConfirm, "skip surfaces the warning even when iCloud is off")
    }

    func test_skip_showsWarning_thenCanCancel() {
        let vm = SecureAccountViewModel(iCloudAvailable: true)
        vm.requestSkip()
        XCTAssertTrue(vm.showSkipConfirm, "the skip warning is shown")
        vm.cancelSkip()
        XCTAssertFalse(vm.showSkipConfirm, "Back dismisses the warning without skipping")
    }

    func test_canSwitchFromCloudToFileAndBack() {
        let vm = SecureAccountViewModel(iCloudAvailable: true)
        XCTAssertEqual(vm.selected, .cloud)
        vm.selectFile()
        XCTAssertEqual(vm.selected, .file)
        vm.selectCloud()
        XCTAssertEqual(vm.selected, .cloud, "cloud is re-selectable when available")
    }
}
