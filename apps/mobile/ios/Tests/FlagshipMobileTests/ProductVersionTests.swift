import XCTest
@testable import FlagshipUI

final class ProductVersionTests: XCTestCase {
    func testAboutNamesTheProductVersionAndTheStoreBuild() {
        XCTAssertEqual(
            ProductVersion.aboutLine(short: "1.1", build: "5"),
            "Flagship 0.2 Beta (iOS 1.1, build 5)"
        )
    }

    func testAboutStillNamesTheProductWhenTheBundleIsUnreadable() {
        XCTAssertEqual(ProductVersion.aboutLine(short: nil, build: "5"), "Flagship 0.2 Beta")
        XCTAssertEqual(ProductVersion.aboutLine(short: "1.1", build: nil), "Flagship 0.2 Beta")
    }
}
