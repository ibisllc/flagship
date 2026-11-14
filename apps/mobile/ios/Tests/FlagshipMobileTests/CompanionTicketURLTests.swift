import XCTest
@testable import FlagshipCore

/// P14 — the `https://webapp.flagshipserver.com/?companion=...` shape parses
/// back to its envelope, and the base64url-no-padding helpers round-trip.
final class CompanionTicketURLTests: XCTestCase {

    private func companionURL(_ env: CompanionTicketURL.Envelope) throws -> String {
        let json = try JSONEncoder().encode(env)
        return "https://\(CompanionTicketURL.webappHost)/?companion=\(CompanionTicketURL.base64URLNoPadding(json))"
    }

    func test_parse_roundTripsAnEncodedEnvelope() throws {
        let original = CompanionTicketURL.Envelope(
            ticketId: "tk-12345678",
            ticketSecret: "0123456789abcdef0123456789abcdef",
            podBaseUrl: "https://home.harry.flagship.services",
            username: "harry"
        )
        let url = try companionURL(original)
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
        let url = try companionURL(original)
        let parsed = CompanionTicketURL.parse(url)!
        XCTAssertEqual(parsed.ticketId, original.ticketId)
        XCTAssertEqual(parsed.ticketSecret, original.ticketSecret)
        XCTAssertEqual(parsed.podBaseUrl, original.podBaseUrl)
        XCTAssertEqual(parsed.username, original.username)
    }

    func test_parse_rejectsGarbage() {
        XCTAssertNil(CompanionTicketURL.parse("https://webapp.flagshipserver.com/"))
        XCTAssertNil(CompanionTicketURL.parse("https://webapp.flagshipserver.com/?companion="))
        XCTAssertNil(CompanionTicketURL.parse("https://webapp.flagshipserver.com/?companion=not-base64!"))
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

    func test_remoteApprovalLink_parsesRelaySessionAndBrowserKey() {
        let sid = Base64URL.encode(Data(repeating: 7, count: 16))
        let key = Data(repeating: 9, count: 32)
        let parsed = RemoteApprovalLink.parse("flagship://remote?s=\(sid)&k=\(Base64URL.encode(key))")
        XCTAssertEqual(parsed?.sid, sid)
        XCTAssertEqual(parsed?.browserPublicKey, key)
    }

    func test_remoteApprovalLink_parsesUniversalLink() {
        let sid = Base64URL.encode(Data(repeating: 7, count: 16))
        let key = Data(repeating: 9, count: 32)
        let k = Base64URL.encode(key)
        for link in [
            "https://flagshipserver.com/remote?s=\(sid)&k=\(k)",
            "https://www.flagshipserver.com/remote?s=\(sid)&k=\(k)",
            "https://flagshipserver.com/remote/?s=\(sid)&k=\(k)",
        ] {
            let parsed = RemoteApprovalLink.parse(link)
            XCTAssertEqual(parsed?.sid, sid, link)
            XCTAssertEqual(parsed?.browserPublicKey, key, link)
        }
        XCTAssertNil(RemoteApprovalLink.parse("https://evil.example/remote?s=\(sid)&k=\(k)"))
        XCTAssertNil(RemoteApprovalLink.parse("http://flagshipserver.com/remote?s=\(sid)&k=\(k)"))
        XCTAssertNil(RemoteApprovalLink.parse("https://remote.flagshipserver.com/remote?s=\(sid)&k=\(k)"))
        XCTAssertNil(RemoteApprovalLink.parse("https://flagshipserver.com/remote/x?s=\(sid)&k=\(k)"))
    }

    func test_remoteApprovalLink_rejectsOtherShapes() {
        let sid = Base64URL.encode(Data(repeating: 7, count: 16))
        let k = Base64URL.encode(Data(repeating: 9, count: 32))
        XCTAssertNil(RemoteApprovalLink.parse("flagship://dock?s=\(sid)&k=\(k)"))
        XCTAssertNil(RemoteApprovalLink.parse("https://flagshipserver.com/qr?s=\(sid)&k=\(k)"))
        XCTAssertNil(RemoteApprovalLink.parse("flagship://remote?s=\(sid)&k=\(Base64URL.encode(Data(repeating: 9, count: 31)))"))
        XCTAssertNil(RemoteApprovalLink.parse("flagship://remote?s=short&k=\(k)"))
        XCTAssertNil(RemoteApprovalLink.parse(
            "flagship://remote?server=home.alice.flagship.services&request=\(String(repeating: "ab", count: 16))&code=\(String(repeating: "cd", count: 32))"
        ))
    }

    func test_remoteTicketPayload_wireShape() throws {
        let payload = RemoteTicketPayload(ticketId: "a", ticketSecret: "b", podBaseUrl: "https://h", username: "u")
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: String]
        XCTAssertEqual(obj, ["kind": "flagship/remote-ticket/v1", "ticketId": "a", "ticketSecret": "b", "podBaseUrl": "https://h", "username": "u"])
    }

    // MARK: - browser extension pairing link

    func test_extensionPairLink_parsesBothForms() {
        let sid = Base64URL.encode(Data(repeating: 7, count: 16))
        let key = Data(repeating: 9, count: 32)
        let k = Base64URL.encode(key)
        for link in [
            "https://flagshipserver.com/pair-extension?s=\(sid)&k=\(k)",
            "https://www.flagshipserver.com/pair-extension/?s=\(sid)&k=\(k)",
            "flagship://pair-extension?s=\(sid)&k=\(k)",
        ] {
            let parsed = ExtensionPairLink.parse(link)
            XCTAssertEqual(parsed?.sid, sid, link)
            XCTAssertEqual(parsed?.browserPublicKey, key, link)
        }
    }

    func test_extensionAndRemoteLinks_neverCross() {
        let sid = Base64URL.encode(Data(repeating: 7, count: 16))
        let k = Base64URL.encode(Data(repeating: 9, count: 32))
        for remote in ["https://flagshipserver.com/remote?s=\(sid)&k=\(k)", "flagship://remote?s=\(sid)&k=\(k)"] {
            XCTAssertNotNil(RemoteApprovalLink.parse(remote))
            XCTAssertNil(ExtensionPairLink.parse(remote), remote)
        }
        for ext in ["https://flagshipserver.com/pair-extension?s=\(sid)&k=\(k)", "flagship://pair-extension?s=\(sid)&k=\(k)"] {
            XCTAssertNotNil(ExtensionPairLink.parse(ext))
            XCTAssertNil(RemoteApprovalLink.parse(ext), ext)
        }
    }

    func test_extensionPairLink_refusesOtherHostsAndShapes() {
        let sid = Base64URL.encode(Data(repeating: 7, count: 16))
        let k = Base64URL.encode(Data(repeating: 9, count: 32))
        XCTAssertNil(ExtensionPairLink.parse("https://evil.example/pair-extension?s=\(sid)&k=\(k)"))
        XCTAssertNil(ExtensionPairLink.parse("http://flagshipserver.com/pair-extension?s=\(sid)&k=\(k)"))
        XCTAssertNil(ExtensionPairLink.parse("https://remote.flagshipserver.com/pair-extension?s=\(sid)&k=\(k)"))
        XCTAssertNil(ExtensionPairLink.parse("https://flagshipserver.com/pair-extension/x?s=\(sid)&k=\(k)"))
        XCTAssertNil(ExtensionPairLink.parse("https://flagshipserver.com/qr?s=\(sid)&k=\(k)"))
        XCTAssertNil(ExtensionPairLink.parse("flagship://pair-extension?s=short&k=\(k)"))
        XCTAssertNil(ExtensionPairLink.parse("flagship://pair-extension?s=\(sid)&k=\(Base64URL.encode(Data(repeating: 9, count: 31)))"))
    }

    func test_extensionPairPayload_wireShape() throws {
        let payload = ExtensionPairPayload(
            serverDomain: "Home.Alice.flagship.services",
            stkPub: Data(repeating: 0xab, count: 32),
            ticketId: "t", ticketSecret: "s", username: "alice"
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let json = String(decoding: try encoder.encode(payload), as: UTF8.self)
        XCTAssertEqual(json, #"{"kind":"flagship/extension-pair/v1","podBaseUrl":"https://home.alice.flagship.services","serverDomain":"home.alice.flagship.services","stkPubHex":"\#(String(repeating: "ab", count: 32))","ticketId":"t","ticketSecret":"s","username":"alice"}"#)
    }
}
