import XCTest
@testable import FlagshipUI
@testable import Flagship
@testable import FlagshipCore
@testable import FlagshipAPI

@MainActor
final class ServerLabelFirstFreeTests: XCTestCase {
    func testFirstFreeStartsAtHome() {
        XCTAssertEqual(ServerLabel.firstFree(taken: [String]()), "home")
    }

    func testFirstFreeSkipsTakenLabelsCaseInsensitively() {
        XCTAssertEqual(ServerLabel.firstFree(taken: ["Home"]), "home2")
        XCTAssertEqual(ServerLabel.firstFree(taken: ["home", "home2", "other"]), "home3")
    }

    func testFirstFreeFillsAGap() {
        XCTAssertEqual(ServerLabel.firstFree(taken: ["home2", "home3"]), "home")
    }

    private func makeVM() -> CreateServerViewModel {
        CreateServerViewModel(
            username: "harry",
            server: MockFlagshipServerClient(),
            relay: MockQrRelayClient(),
            isDemoAccount: false
        )
    }

    func testCreateServerPrefillsTheNextFreeName() {
        let vm = makeVM()
        vm.prefillName(takenLabels: ["home", "home2"])
        XCTAssertEqual(vm.name, "home3")
        XCTAssertTrue(vm.canAdvanceFromDesign)
    }

    func testPrefillKeepsWhatTheUserTyped() {
        let vm = makeVM()
        vm.name = "attic"
        vm.prefillName(takenLabels: ["home"])
        XCTAssertEqual(vm.name, "attic")
    }
}
