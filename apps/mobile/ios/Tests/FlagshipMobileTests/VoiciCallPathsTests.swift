import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// Privacy policy §2.12: the call-back request addresses name no account. The owner's ring goes to
/// /api/voici/rings/<ringId>; the caller app's ring-back order goes to /api/voici/web/ring-back with no query (`.com`
/// takes the account from the signing device). Mirrors Android VoiciCallPathsTest.
final class VoiciCallPathsTests: XCTestCase {
    private var seen: [URLRequest] = []

    private func client() -> LiveVoiciComClient {
        StubURLProtocol.handler = { [unowned self] req in
            self.seen.append(req)
            return (HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(#"{"ok":true}"#.utf8))
        }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return LiveVoiciComClient(session: URLSession(configuration: cfg), base: URL(string: "https://flagshipserver.com")!, readTokens: nil, caKeys: { [] })
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    func test_theOwnersRingNamesOnlyTheRing() async throws {
        let c = client()
        let ring: JSONValue = ["pageId": "p", "conv": "c", "ringId": "0123456789abcdef0123456789abcdef", "hint": "", "media": "audio", "issuedAt": 1]
        try await c.ring(username: "alice", ring: ring, signature: "00")
        let url = try XCTUnwrap(seen.last?.url)
        XCTAssertEqual(url.absoluteString, "https://flagshipserver.com/api/voici/rings/0123456789abcdef0123456789abcdef")
        XCTAssertFalse(url.absoluteString.contains("alice"))
    }

    func test_aMalformedRingIdIsRefusedBeforeAnyRequest() async {
        let c = client()
        let ring: JSONValue = ["ringId": "../alice/ring"]
        do {
            try await c.ring(username: "alice", ring: ring, signature: "00")
            XCTFail("expected a refusal")
        } catch let e as VoiciComError {
            XCTAssertEqual(e.code, "malformed")
        } catch { XCTFail("\(error)") }
        XCTAssertTrue(seen.isEmpty)
    }

    func test_theRingBackOrderHasNoAccountInTheAddress() async throws {
        let c = client()
        var signedPath = ""
        try await c.ringBack(order: ["order": ["pageId": "p"]], account: "alice") { _, path in
            signedPath = path
            return AccountDirectoryAuthorization(deviceId: "d1", signerPubHex: String(repeating: "a", count: 64), requestId: "r", issuedAt: 1, signatureHex: "s")
        }
        let req = try XCTUnwrap(seen.last)
        XCTAssertEqual(req.url?.absoluteString, "https://flagshipserver.com/api/voici/web/ring-back")
        XCTAssertNil(req.url?.query)
        XCTAssertEqual(signedPath, "/api/voici/web/ring-back")
        XCTAssertEqual(req.value(forHTTPHeaderField: "x-flagship-device-pub"), String(repeating: "a", count: 64))
    }
}
