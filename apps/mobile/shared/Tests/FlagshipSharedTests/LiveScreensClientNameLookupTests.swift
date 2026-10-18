import XCTest
@testable import FlagshipAPI

/// A home router that cached "no such name" (the box's name was looked up before
/// it registered) made every box-direct call fail with cannotFindHost for ~30
/// minutes while the server was Online. The call is tried again with a short
/// backoff, and the failure that remains is said as a name problem.
final class LiveScreensClientNameLookupTests: XCTestCase {
    private final class Resolver: URLProtocol, @unchecked Sendable {
        nonisolated(unsafe) static var failuresLeft = 0
        nonisolated(unsafe) static var calls = 0
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            Self.calls += 1
            if Self.failuresLeft > 0 {
                Self.failuresLeft -= 1
                client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
                return
            }
            let resp = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(#"{"apps":[]}"#.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    private final class Slept: @unchecked Sendable {
        var delays: [TimeInterval] = []
    }

    private func client(slept: Slept, delays: [TimeInterval] = [0.5, 1.5, 3]) async -> LiveScreensClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [Resolver.self]
        let store = SessionStore(defaults: UserDefaults(suiteName: "dns-\(UUID().uuidString)")!)
        await store.setPodBaseUrl("https://home.harry.flagship.services")
        await store.setSessionToken("tok")
        return LiveScreensClient(
            urlSession: URLSession(configuration: cfg), store: store,
            dnsRetryDelays: delays, sleep: { slept.delays.append($0) }
        )
    }

    func test_aNameThatWontResolveYetIsTriedAgainAndThenWorks() async throws {
        Resolver.failuresLeft = 2
        Resolver.calls = 0
        let slept = Slept()
        let c = await client(slept: slept)
        let apps = try await c.appsList()
        XCTAssertTrue(apps.apps.isEmpty)
        XCTAssertEqual(Resolver.calls, 3, "two misses, then the answer")
        XCTAssertEqual(slept.delays, [0.5, 1.5], "with a growing pause between tries")
    }

    func test_whenItNeverResolvesTheFailureIsAboutTheNameNotTheConnection() async {
        Resolver.failuresLeft = 99
        Resolver.calls = 0
        let slept = Slept()
        let c = await client(slept: slept)
        do {
            _ = try await c.appsList()
            XCTFail("expected a failure")
        } catch {
            XCTAssertTrue(LiveScreensClient.isNameLookupFailure(error))
            XCTAssertEqual(Resolver.calls, 4, "the first try plus three more")
            XCTAssertEqual(ScreensClientError.userFacing(error), UserErrorText.nameLookup)
            XCTAssertFalse(ScreensClientError.userFacing(error).contains("Couldn't reach the server"))
        }
    }

    func test_otherFailuresAreNotRetried() async {
        Resolver.failuresLeft = 0
        Resolver.calls = 0
        XCTAssertFalse(LiveScreensClient.isNameLookupFailure(URLError(.timedOut)))
        XCTAssertFalse(LiveScreensClient.isNameLookupFailure(URLError(.cannotConnectToHost)))
        XCTAssertTrue(LiveScreensClient.isNameLookupFailure(URLError(.dnsLookupFailed)))
    }
}
