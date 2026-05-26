import XCTest
@testable import FlagshipCore

/// P14 — verifies the exact `https://web.flagshipserver.com/?companion=...`
/// shape the QR encodes + that the base64url-no-padding payload round-
/// trips back to the original envelope. The webapp + Android decoders
/// MUST be byte-compatible with this encoder.
final class CompanionTicketURLTests: XCTestCase {

    func test_build_emitsExpectedHostAndPath() {
        let url = CompanionTicketURL.build(
            ticketId: "tk-abc",
            ticketSecret: "sek",
            podBaseUrl: "https://home.harry.flagship.services",
            username: "harry"
        )
        XCTAssertNotNil(url)
        XCTAssertTrue(url!.hasPrefix("https://web.flagshipserver.com/?companion="))
    }

    func test_build_payloadIsBase64URLNoPadding() {
        let url = CompanionTicketURL.build(
            ticketId: "tk-abc",
            ticketSecret: "sek",
            podBaseUrl: "https://home.harry.flagship.services",
            username: "harry"
        )!
        let comps = URLComponents(string: url)!
        let value = comps.queryItems!.first(where: { $0.name == "companion" })!.value!
        // No padding.
        XCTAssertFalse(value.contains("="), "base64url must omit padding")
        // No `+` or `/` (RFC 4648 §5).
        XCTAssertFalse(value.contains("+"), "base64url must use `-` not `+`")
        XCTAssertFalse(value.contains("/"), "base64url must use `_` not `/`")
        // Must decode back to JSON.
        XCTAssertNotNil(CompanionTicketURL.decodeBase64URLNoPadding(value))
    }

    func test_build_roundTripsViaURLComponents_parsesJSONIdentically() throws {
        let original = CompanionTicketURL.Envelope(
            ticketId: "tk-12345678",
            ticketSecret: "0123456789abcdef0123456789abcdef",
            podBaseUrl: "https://home.harry.flagship.services",
            username: "harry"
        )
        let url = CompanionTicketURL.build(
            ticketId: original.ticketId,
            ticketSecret: original.ticketSecret,
            podBaseUrl: original.podBaseUrl,
            username: original.username
        )!
        let parsed = CompanionTicketURL.parse(url)
        XCTAssertEqual(parsed, original)
    }

    func test_parse_handlesSpecialCharactersInUsername() throws {
        let original = CompanionTicketURL.Envelope(
            ticketId: "tk-xyz",
            ticketSecret: "deadbeefdeadbeef",
            podBaseUrl: "https://demouser734759.flagship.services",
            username: "demouser734759"
        )
        let url = CompanionTicketURL.build(
            ticketId: original.ticketId,
            ticketSecret: original.ticketSecret,
            podBaseUrl: original.podBaseUrl,
            username: original.username
        )!
        let parsed = CompanionTicketURL.parse(url)!
        XCTAssertEqual(parsed.ticketId, original.ticketId)
        XCTAssertEqual(parsed.ticketSecret, original.ticketSecret)
        XCTAssertEqual(parsed.podBaseUrl, original.podBaseUrl)
        XCTAssertEqual(parsed.username, original.username)
    }

    func test_parse_rejectsGarbage() {
        XCTAssertNil(CompanionTicketURL.parse("https://web.flagshipserver.com/"))
        XCTAssertNil(CompanionTicketURL.parse("https://web.flagshipserver.com/?companion="))
        XCTAssertNil(CompanionTicketURL.parse("https://web.flagshipserver.com/?companion=not-base64!"))
        XCTAssertNil(CompanionTicketURL.parse("not a url at all"))
    }

    func test_base64URLNoPadding_knownVector() {
        // Hand-derived: base64("\x00") = "AA==" → base64url = "AA" (no
        // padding). One-byte input lands the shortest non-empty case.
        XCTAssertEqual(CompanionTicketURL.base64URLNoPadding(Data([0])), "AA")
        // Two bytes "\xff\xff": base64 = "//8=" → base64url = "__8".
        XCTAssertEqual(CompanionTicketURL.base64URLNoPadding(Data([0xff, 0xff])), "__8")
        // Three bytes "\x14\xfb\x9c": base64 = "FPuc" → base64url = "FPuc".
        XCTAssertEqual(CompanionTicketURL.base64URLNoPadding(Data([0x14, 0xfb, 0x9c])), "FPuc")
    }

    func test_base64URLNoPadding_decodeIsSymmetric() {
        let cases: [Data] = [
            Data(),
            Data([0]),
            Data([0xff, 0xff]),
            Data([0x14, 0xfb, 0x9c]),
            Data((0..<32).map { UInt8($0) })
        ]
        for original in cases {
            let encoded = CompanionTicketURL.base64URLNoPadding(original)
            let decoded = CompanionTicketURL.decodeBase64URLNoPadding(encoded)
            XCTAssertEqual(decoded, original)
        }
    }

    // MARK: - podBaseUrl(forFqdn:)

    func test_podBaseUrl_prefixesHttpsToBareFqdn() {
        XCTAssertEqual(
            CompanionTicketURL.podBaseUrl(forFqdn: "home.harry.flagship.services"),
            "https://home.harry.flagship.services"
        )
    }

    func test_podBaseUrl_keepsExistingScheme() {
        XCTAssertEqual(
            CompanionTicketURL.podBaseUrl(forFqdn: "https://home.harry.flagship.services"),
            "https://home.harry.flagship.services"
        )
        XCTAssertEqual(
            CompanionTicketURL.podBaseUrl(forFqdn: "http://localhost:8080"),
            "http://localhost:8080"
        )
    }

    func test_podBaseUrl_trimsWhitespace() {
        XCTAssertEqual(
            CompanionTicketURL.podBaseUrl(forFqdn: "  home.harry.flagship.services  "),
            "https://home.harry.flagship.services"
        )
    }
}
