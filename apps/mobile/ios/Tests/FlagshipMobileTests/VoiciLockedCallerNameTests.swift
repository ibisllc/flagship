import XCTest
@testable import FlagshipCore
@testable import FlagshipUI

/// A locked phone names the caller from the room's signed request alone: the visitor name, never a nickname.
final class VoiciLockedCallerNameTests: XCTestCase {
    func test_aPseudonymGetsItsVisitorName() throws {
        let from = String(repeating: "ab", count: 32)
        let expected = try VoiciText.voiciPseudonymName(from, prefix: String(localized: "Visitor "))
        XCTAssertEqual(VoiciCallCenter.lockedCallerName(from: from), expected)
        XCTAssertTrue(expected.hasPrefix("Visitor "))
    }

    func test_aBrowserKeyIsAnAnonymousCaller() {
        let browserKey = "04" + String(repeating: "cd", count: 64)
        XCTAssertEqual(VoiciCallCenter.lockedCallerName(from: browserKey), String(localized: "Anonymous caller"))
    }
}
