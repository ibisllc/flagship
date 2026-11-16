import XCTest
@testable import FlagshipUI

/// Covers the **Secure your account** onboarding step's two independent
/// ticks, the skip confirmation and the iCloud-availability gating.
///
///   - both options start unticked, so Continue waits for a choice,
///   - cloud and file tick independently (either, both, neither),
///   - cloud off → cloud can't be ticked, but file + skip still work,
///   - skip → the warning (confirmation) is surfaced.
@MainActor
final class SecureAccountViewModelTests: XCTestCase {

    func test_bothOptionsStartUnticked() {
        let vm = SecureAccountViewModel(iCloudAvailable: true)
        XCTAssertFalse(vm.cloudSelected, "cloud starts unticked")
        XCTAssertFalse(vm.fileSelected, "file starts unticked")
        XCTAssertTrue(vm.canSelectCloud)
        XCTAssertFalse(vm.canContinue, "Continue waits for a choice; Skip is the way out")
    }

    func test_optionsAreIndependent() {
        let vm = SecureAccountViewModel(iCloudAvailable: true)
        vm.toggleCloud()
        XCTAssertTrue(vm.cloudSelected)
        XCTAssertFalse(vm.fileSelected, "ticking cloud leaves the file alone")
        XCTAssertTrue(vm.canContinue)
        vm.toggleFile()
        XCTAssertTrue(vm.cloudSelected, "ticking the file keeps cloud ticked")
        XCTAssertTrue(vm.fileSelected)
        XCTAssertTrue(vm.canContinue)
        vm.toggleCloud()
        XCTAssertFalse(vm.cloudSelected)
        XCTAssertTrue(vm.fileSelected, "unticking cloud keeps the file")
        XCTAssertTrue(vm.canContinue)
        vm.toggleFile()
        XCTAssertFalse(vm.canContinue, "with neither ticked Continue is off again")
    }

    func test_cloudOff_cloudNotTickable() {
        let vm = SecureAccountViewModel(iCloudAvailable: false)
        XCTAssertFalse(vm.canSelectCloud)
        vm.toggleCloud()
        XCTAssertFalse(vm.cloudSelected, "cloud stays unticked when iCloud is off")
        XCTAssertFalse(vm.canContinue)
    }

    func test_cloudOff_fileStillWorks() {
        let vm = SecureAccountViewModel(iCloudAvailable: false)
        vm.toggleFile()
        XCTAssertTrue(vm.fileSelected)
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
}
