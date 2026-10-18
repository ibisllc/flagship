import XCTest
@testable import FlagshipBuilderCore

final class StudioVersionTests: XCTestCase {
    func testAReleaseReadsAsTheProductVersionWithItsLabel() {
        XCTAssertEqual(StudioVersion.display(bundleVersion: "0.2.0"), "0.2 Beta")
    }

    func testADevBuildIsShownAsIs() {
        XCTAssertEqual(StudioVersion.display(bundleVersion: "0.0.0-dev"), "0.0.0-dev")
        XCTAssertEqual(StudioVersion.display(bundleVersion: nil), "dev")
    }

    func testAPatchReleaseIsNotHiddenBehindTheProductVersion() {
        XCTAssertEqual(StudioVersion.display(bundleVersion: "0.2.1"), "0.2.1")
    }
}
