import XCTest
import UIKit
@testable import FlagshipUI

final class OrientationPolicyTests: XCTestCase {

    func test_phoneSizedScreens_arePortraitOnly() {
        // iPhone 17 Pro Max, iPhone SE, and the iPhone Duo's outer display.
        for size in [CGSize(width: 440, height: 956), CGSize(width: 375, height: 667), CGSize(width: 466, height: 678)] {
            XCTAssertEqual(OrientationPolicy.mask(forScreenSize: size), .portrait, "\(size)")
        }
    }

    func test_tabletSizedScreens_areLandscapeOnly() {
        // iPhone Duo inner display, iPad mini, iPad Pro 13".
        for size in [CGSize(width: 669, height: 951), CGSize(width: 744, height: 1133), CGSize(width: 1032, height: 1376)] {
            XCTAssertEqual(OrientationPolicy.mask(forScreenSize: size), .landscape, "\(size)")
        }
    }

    func test_decisionIgnoresCurrentOrientation() {
        // `UIScreen.bounds` follows the interface orientation, so the same
        // screen must classify the same way whichever way round it reports.
        XCTAssertEqual(OrientationPolicy.mask(forScreenSize: CGSize(width: 951, height: 669)), .landscape)
        XCTAssertEqual(OrientationPolicy.mask(forScreenSize: CGSize(width: 678, height: 466)), .portrait)
    }
}
