import XCTest
@testable import FlagshipUI

/// The product number comes from release/version.json through
/// `scripts/check-versions.mjs --write`, which keeps `ProductVersion.product`
/// in step (and `npm run parity` fails on drift), so these tests read it from
/// the constant instead of pinning a release.
final class ProductVersionTests: XCTestCase {
    func testProductConstantIsAPlainVersionNumber() {
        XCTAssertNotNil(
            ProductVersion.product.range(of: #"^\d+\.\d+$"#, options: .regularExpression),
            "ProductVersion.product should be release/version.json's product, e.g. 0.3"
        )
    }

    func testAboutNamesTheProductVersionAndTheStoreBuild() {
        XCTAssertEqual(
            ProductVersion.aboutLine(short: "1.1", build: "5"),
            "Flagship \(ProductVersion.product) Beta (iOS 1.1, build 5)"
        )
    }

    func testAboutStillNamesTheProductWhenTheBundleIsUnreadable() {
        XCTAssertEqual(ProductVersion.aboutLine(short: nil, build: "5"), "Flagship \(ProductVersion.product) Beta")
        XCTAssertEqual(ProductVersion.aboutLine(short: "1.1", build: nil), "Flagship \(ProductVersion.product) Beta")
    }
}
