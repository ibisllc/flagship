import XCTest
@testable import FlagshipCore

final class SlugUtilTests: XCTestCase {
    func test_lowercasesAndSpacesBecomeDashes() {
        XCTAssertEqual(SlugUtil.slugify("Music Projects"), "music-projects")
    }

    func test_stripsPunctuationAndUppercase() {
        XCTAssertEqual(SlugUtil.slugify("Harry's Mac!"), "harrys-mac")
    }

    func test_emptyFallsBackToServer() {
        XCTAssertEqual(SlugUtil.slugify(""), "server")
        XCTAssertEqual(SlugUtil.slugify("!!!"), "server")
    }

    func test_preservesDigits() {
        XCTAssertEqual(SlugUtil.slugify("Server 42"), "server-42")
    }
}
