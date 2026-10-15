import XCTest
@testable import FlagshipAPI

/// `.com` answers a rate-limited call with 429 + `{ error: "rate-limited",
/// endpoint, limit, retryAfterSec, message }`. The sentence is rebuilt here with
/// the Worker's wording (apps/com/src/rateLimit.ts `rateLimitedMessage`), and
/// every client path turns that body into it.
final class RateLimitedRefusalTests: XCTestCase {

    private func body(limit: String? = "ip", retryAfterSec: Int? = 720, message: String? = nil,
                      endpoint: String = "username-claim") -> String {
        var obj: [String: Any] = ["error": "rate-limited", "endpoint": endpoint]
        if let limit { obj["limit"] = limit }
        if let retryAfterSec { obj["retryAfterSec"] = retryAfterSec }
        if let message { obj["message"] = message }
        let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
        return String(data: data, encoding: .utf8)!
    }

    // MARK: - Wording

    func testEachAxis() {
        XCTAssertEqual(RateLimitedRefusal.sentence(limit: .ip, retryAfterSec: 720),
                       "Too many tries from your network. Try again in about 12 minutes.")
        XCTAssertEqual(RateLimitedRefusal.sentence(limit: .irk, retryAfterSec: 720),
                       "Too many tries from this account. Try again in about 12 minutes.")
        XCTAssertEqual(RateLimitedRefusal.sentence(limit: .usernameHash, retryAfterSec: 720),
                       "Too many tries for this account name. Try again in about 12 minutes.")
    }

    func testTimeBoundaries() {
        let p = RateLimitedRefusal.retryAfterPhrase
        XCTAssertEqual(p(0), "in a minute")
        XCTAssertEqual(p(59), "in a minute")
        XCTAssertEqual(p(60), "in about 1 minute")
        XCTAssertEqual(p(61), "in about 2 minutes")
        XCTAssertEqual(p(120), "in about 2 minutes")
        XCTAssertEqual(p(3540), "in about 59 minutes")
        XCTAssertEqual(p(3541), "in about 1 hour")
        XCTAssertEqual(p(3600), "in about 1 hour")
        XCTAssertEqual(p(5340), "in about 1 hour")   // 89 min
        XCTAssertEqual(p(5400), "in about 2 hours")  // 90 min rounds up, as Math.round does
        XCTAssertEqual(p(7200), "in about 2 hours")
        XCTAssertEqual(p(86_400), "in about 24 hours")
    }

    // MARK: - Parsing

    func testParsesTheBody() throws {
        let r = try XCTUnwrap(RateLimitedRefusal.from(status: 429, body: body(limit: "irk", retryAfterSec: 30)))
        XCTAssertEqual(r.endpoint, "username-claim")
        XCTAssertEqual(r.limit, .irk)
        XCTAssertEqual(r.retryAfterSec, 30)
        XCTAssertEqual(r.message, "Too many tries from this account. Try again in a minute.")
    }

    func testOwnSentenceWinsOverServerMessage() {
        let r = RateLimitedRefusal.from(status: 429, body: body(message: "server words"))
        XCTAssertEqual(r?.message, "Too many tries from your network. Try again in about 12 minutes.")
    }

    func testFallsBackToServerMessageThenGeneric() {
        XCTAssertEqual(RateLimitedRefusal.from(status: 429, body: body(limit: "galaxy", message: "From .com."))?.message,
                       "From .com.")
        XCTAssertEqual(RateLimitedRefusal.from(status: 429, body: body(retryAfterSec: nil, message: "From .com."))?.message,
                       "From .com.")
        XCTAssertEqual(RateLimitedRefusal.from(status: 429, body: body(limit: nil, retryAfterSec: nil))?.message,
                       "Too many tries. Try again later.")
        XCTAssertEqual(RateLimitedRefusal.from(status: 429, body: body(limit: nil, message: "  "))?.message,
                       "Too many tries. Try again later.")
    }

    func testOnlyTheRateLimitedShapeMatches() {
        XCTAssertNil(RateLimitedRefusal.from(status: 400, body: body()))
        XCTAssertNil(RateLimitedRefusal.from(status: 429, body: ""))
        XCTAssertNil(RateLimitedRefusal.from(status: 429, body: "too many"))
        XCTAssertNil(RateLimitedRefusal.from(status: 429, body: #"{"retryAfterMs":4000}"#))
        XCTAssertNil(RateLimitedRefusal.from(status: 429, body: #"{"error":"used up","code":"free-ai-used-up"}"#))
    }

    // MARK: - Error surfaces

    func testScreensClientErrorShowsTheSentence() {
        let e = ScreensClientError.http(status: 429, message: body(limit: "usernameHash", retryAfterSec: 900))
        let expected = "Too many tries for this account name. Try again in about 15 minutes."
        XCTAssertEqual(e.errorDescription, expected)
        XCTAssertEqual(e.localizedDescription, expected)
        XCTAssertEqual(ScreensClientError.userFacing(e), expected)
        XCTAssertEqual(ScreensClientError.boxReason(e), expected)
        XCTAssertEqual(RateLimitedRefusal.from(e)?.retryAfterSec, 900)
    }

    func testOtherTooManyRequestsKeepTheOldCopy() {
        let e = ScreensClientError.http(status: 429, message: "wipe-restart rate-limited")
        XCTAssertEqual(e.errorDescription, "The server is busy right now. Give it a moment and try again.")
        XCTAssertNil(RateLimitedRefusal.from(e))
    }

    func testFreeAiMapsTheRateLimitedShape() {
        let e = FreeAiError.from(status: 429, body: Data(body(limit: "ip", retryAfterSec: 120).utf8))
        guard case .rateLimited(let r)? = e else { return XCTFail("got \(String(describing: e))") }
        XCTAssertEqual(r.limit, .ip)
        XCTAssertEqual(e?.message, "Too many tries from your network. Try again in about 2 minutes.")
        XCTAssertEqual(e.map(ScreensClientError.userFacing), "Too many tries from your network. Try again in about 2 minutes.")
        XCTAssertEqual(FreeAiEntryState.of(e!), .disabled(message: e!.message, offerOwnKey: true))
        // The older 429s still mean "used up".
        if case .usedUp? = FreeAiError.from(status: 429, body: Data(#"{"code":"free-ai-used-up","error":"x"}"#.utf8)) {} else {
            XCTFail("free-ai-used-up should stay usedUp")
        }
    }
}

// MARK: - The live client against a stubbed `.com`

final class RateLimitedLiveClientTests: XCTestCase {
    private let rateLimited = #"{"error":"rate-limited","endpoint":"username-claim","limit":"ip","retryAfterSec":720,"message":"Too many tries from your network. Try again in about 12 minutes."}"#
    private let sentence = "Too many tries from your network. Try again in about 12 minutes."

    override func tearDown() {
        RateLimitStubProtocol.respond = nil
        super.tearDown()
    }

    private func client(status: Int, body: String) -> LiveFlagshipServerClient {
        RateLimitStubProtocol.respond = { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil,
                                       headerFields: ["content-type": "application/json", "retry-after": "720"])!
            return (resp, Data(body.utf8))
        }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RateLimitStubProtocol.self]
        return LiveFlagshipServerClient(urlSession: URLSession(configuration: cfg),
                                        baseUrl: URL(string: "https://control.test")!)
    }

    private func assertRateLimited(_ op: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            try await op()
            XCTFail("expected a throw", file: file, line: line)
        } catch {
            XCTAssertEqual(RateLimitedRefusal.from(error)?.limit, .ip, file: file, line: line)
            XCTAssertEqual(ScreensClientError.userFacing(error), sentence, file: file, line: line)
            XCTAssertEqual(error.localizedDescription, sentence, file: file, line: line)
        }
    }

    func testResolveAccount() async {
        let c = client(status: 429, body: rateLimited)
        await assertRateLimited { _ = try await c.resolveAccount(username: "alice") }
    }

    func testIssueAuthCodeAndAdmit() async {
        let c = client(status: 429, body: rateLimited)
        let code = AuthCodeWire(version: 1, serial: "01", username: "a", serverName: "s", serverDomain: "d",
                                delegatedPubKey: "11", userPubKey: "22", issuedAt: 1, expiresAt: 2)
        await assertRateLimited { try await c.issueAuthCode(.init(code: code, signature: "x")) }
        await assertRateLimited { _ = try await c.hasCloudRecovery(username: "alice") }
        await assertRateLimited { _ = try await c.listWatchDelegates(username: "alice") }
    }

    func testRecoveryFetchPassesTheRefusalThrough() async {
        let c = client(status: 429, body: rateLimited)
        await assertRateLimited { _ = try await c.fetchWrappedUmk(username: "alice", fetchTokenHex: "00") }
    }

    func testRecoveryFetchKeepsItsOwnWordsForOtherTooManyRequests() async {
        let c = client(status: 429, body: "")
        do {
            _ = try await c.fetchWrappedUmk(username: "alice", fetchTokenHex: "00")
            XCTFail("expected a throw")
        } catch ScreensClientError.http(let status, let message) {
            XCTAssertEqual(status, 429)
            XCTAssertEqual(message, "too many attempts — wait 15 minutes before retrying")
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testUsernameSuggestThrowsTheRefusal() async {
        let c = client(status: 429, body: rateLimited)
        await assertRateLimited { _ = try await c.suggestUsername(deviceKey: "k") }
    }

    func testUsernameSuggestCooldownStillThrottles() async throws {
        let c = client(status: 429, body: #"{"retryAfterMs":4000}"#)
        let s = try await c.suggestUsername(deviceKey: "k")
        XCTAssertEqual(s, UsernameSuggestion(name: nil, retryAfterMs: 4000, throttled: true))
    }

    func testFreeAiStatus() async {
        let c = client(status: 429, body: rateLimited)
        let req = FreeAiSignedRequest(request: FreeAiIssueRequest(username: "a", serverFqdn: "", issuedAt: 1), signature: "x")
        do {
            _ = try await c.freeAiStatus(req)
            XCTFail("expected a throw")
        } catch let e as FreeAiError {
            XCTAssertEqual(e.message, sentence)
            XCTAssertTrue(e.opensAddKey)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testFreeAiUsedUpUnchanged() async {
        let c = client(status: 429, body: #"{"code":"free-ai-used-up","error":"Used up."}"#)
        let req = FreeAiSignedRequest(request: FreeAiIssueRequest(username: "a", serverFqdn: "", issuedAt: 1), signature: "x")
        do {
            _ = try await c.freeAiToken(req)
            XCTFail("expected a throw")
        } catch let e as FreeAiError {
            XCTAssertEqual(e, .usedUp(message: "Used up.", credits: nil))
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}

final class RateLimitStubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var respond: ((URLRequest) -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { respond != nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let respond = Self.respond else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let (resp, data) = respond(request)
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
