import XCTest
@testable import FlagshipUI

final class RootShellLayoutTests: XCTestCase {
    func test_sidebarWidth_isFullOnIPad() {
        XCTAssertEqual(iPadShell.sidebarWidth(for: 1376), 280)
        XCTAssertEqual(iPadShell.sidebarWidth(for: 1133), 280)
    }

    /// A narrower regular-width display (the iPhone Duo's inner screen) must
    /// not leave the content pane narrower than an iPhone's.
    func test_sidebarWidth_shrinksOnNarrowRegularWidth() {
        XCTAssertEqual(iPadShell.sidebarWidth(for: 800), 240)
        XCTAssertEqual(iPadShell.sidebarWidth(for: 600), 220)
        XCTAssertGreaterThanOrEqual(600 - iPadShell.sidebarWidth(for: 600), 375)
    }
}
