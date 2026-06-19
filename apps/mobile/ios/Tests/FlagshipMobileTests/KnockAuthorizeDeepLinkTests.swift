import XCTest
@testable import FlagshipCore

/// Parsing of the web-experience-gating knock-authorize deeplink
/// (docs/service-access-gating.md, "Web-experience gating"):
/// `flagship://access?server=<fqdn>&svc=<label>&ref=<serviceRef>&page=<pageId>`
/// — handed to a browser by the box's knock page (button + QR), and also
/// paste-able via Settings → "Process URL".
final class KnockAuthorizeDeepLinkTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let svc = "notes"
    private let ref = "alice-notes"
    private let page = "cb2421036efeb738c6017d8ee92e7b89"

    private func accessUrl(server: String, svc: String, ref: String, page: String) -> URL {
        var c = URLComponents()
        c.scheme = "flagship"
        c.host = "access"
        c.queryItems = [
            URLQueryItem(name: "server", value: server),
            URLQueryItem(name: "svc", value: svc),
            URLQueryItem(name: "ref", value: ref),
            URLQueryItem(name: "page", value: page),
        ]
        return c.url!
    }

    func testParsesFullAccessDeeplink() {
        let url = accessUrl(server: server, svc: svc, ref: ref, page: page)
        XCTAssertEqual(
            DeepLink.parse(url),
            .knockAuthorize(serverDomain: server, svc: svc, serviceRef: ref, pageId: page)
        )
    }

    func testParsesAccessWithEmptySvc() {
        // svc is display-only and may be empty (apex-served service).
        let url = accessUrl(server: server, svc: "", ref: ref, page: page)
        XCTAssertEqual(
            DeepLink.parse(url),
            .knockAuthorize(serverDomain: server, svc: "", serviceRef: ref, pageId: page)
        )
    }

    func testMissingServerIsNil() {
        let url = accessUrl(server: "", svc: svc, ref: ref, page: page)
        XCTAssertNil(DeepLink.parse(url))
    }

    func testMissingRefIsNil() {
        let url = accessUrl(server: server, svc: svc, ref: "", page: page)
        XCTAssertNil(DeepLink.parse(url))
    }

    func testMissingPageIsNil() {
        let url = accessUrl(server: server, svc: svc, ref: ref, page: "")
        XCTAssertNil(DeepLink.parse(url))
    }

    func testPastedDeeplinkStringParses() {
        let raw = "flagship://access?server=\(server)&svc=\(svc)&ref=\(ref)&page=\(page)"
        XCTAssertEqual(
            DeepLink.parsePastedString(raw),
            .knockAuthorize(serverDomain: server, svc: svc, serviceRef: ref, pageId: page)
        )
    }

    func testPastedStringTrimsWhitespace() {
        let raw = "  \n flagship://access?server=\(server)&svc=\(svc)&ref=\(ref)&page=\(page)\n  "
        XCTAssertEqual(
            DeepLink.parsePastedString(raw),
            .knockAuthorize(serverDomain: server, svc: svc, serviceRef: ref, pageId: page)
        )
    }

    func testPastedGarbageIsNil() {
        XCTAssertNil(DeepLink.parsePastedString("not a link"))
        XCTAssertNil(DeepLink.parsePastedString(""))
        XCTAssertNil(DeepLink.parsePastedString("   "))
    }

    func testPastedInviteLinkAlsoParses() {
        // "Process URL" accepts any recognized Flagship deeplink, not just access.
        let secret = String(repeating: "ab", count: 32)
        let raw = "flagship://invite?server=\(server)&k=\(secret)"
        XCTAssertEqual(
            DeepLink.parsePastedString(raw),
            .inviteRedeem(serverDomain: server, secretHex: secret, authorAidHex: nil, inviteId: nil)
        )
    }
}
