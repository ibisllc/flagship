import XCTest
@testable import FlagshipCore

/// P2 — trademark-claim mailto builder. Asserts the subject + body are
/// byte-identical to the canonical webapp helper
/// (apps/web/public/webapp/lib/trademarkClaim.js) and that the mailto
/// URL encodes them the way JS `encodeURIComponent` does.
final class TrademarkClaimTests: XCTestCase {

    func test_email_isTheTrademarksDesk() {
        XCTAssertEqual(TrademarkClaim.email, "trademarks@flagshipserver.com")
    }

    func test_subject_matchesCanonical() {
        XCTAssertEqual(
            TrademarkClaim.subject(username: "harry"),
            "Trademark claim for the name \"harry\""
        )
    }

    func test_body_matchesCanonicalTemplate() {
        let expected = [
            "Hello,",
            "",
            "I'm requesting the Flagship account name \"harry\" on the basis",
            "that I hold a registered trademark covering it.",
            "",
            "Trademark holder / company: [your name or company]",
            "Trademark registration number: [registration number]",
            "Jurisdiction / registry: [e.g. USPTO, EUIPO]",
            "Goods/services class(es): [class numbers]",
            "Link or attachment to the registration: [URL or note that it's attached]",
            "",
            "Requested name: harry",
            "",
            "Thank you.",
        ].joined(separator: "\n")
        XCTAssertEqual(TrademarkClaim.body(username: "harry"), expected)
    }

    func test_mailto_encodesSubjectAndBody() throws {
        let url = try XCTUnwrap(TrademarkClaim.mailtoURL(username: "harry"))
        let s = url.absoluteString
        XCTAssertTrue(s.hasPrefix("mailto:trademarks@flagshipserver.com?subject="), s)
        XCTAssertTrue(s.contains("&body="), s)
        // The subject "Trademark claim for the name "harry"" encodes the
        // spaces as %20 and the quotes as %22 (encodeURIComponent style).
        XCTAssertTrue(s.contains("Trademark%20claim%20for%20the%20name%20%22harry%22"), s)
        // The body's newlines encode as %0A.
        XCTAssertTrue(s.contains("Hello%2C%0A%0AI'm%20requesting"), s)
    }

    func test_encodeURIComponent_matchesJsUnreservedSet() {
        // encodeURIComponent leaves A-Za-z0-9 and -_.!~*'() unescaped and
        // escapes everything else (notably space, quotes, slash, colon).
        XCTAssertEqual(
            TrademarkClaim.encodeURIComponent("-_.!~*'()"),
            "-_.!~*'()"
        )
        XCTAssertEqual(TrademarkClaim.encodeURIComponent("a b"), "a%20b")
        XCTAssertEqual(TrademarkClaim.encodeURIComponent("\"q\""), "%22q%22")
        XCTAssertEqual(TrademarkClaim.encodeURIComponent("a/b:c"), "a%2Fb%3Ac")
    }

    func test_mailto_username_isUsedVerbatim() throws {
        let url = try XCTUnwrap(TrademarkClaim.mailtoURL(username: "acme42"))
        XCTAssertTrue(url.absoluteString.contains("%22acme42%22"), url.absoluteString)
    }
}
