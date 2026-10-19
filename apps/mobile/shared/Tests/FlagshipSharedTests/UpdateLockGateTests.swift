import XCTest
@testable import FlagshipCore
import FlagshipAPI

/// What the lock refuses (docs/security-notices.md 6.3) and what the notice
/// fetch sends (section 3 and 6.2).
final class UpdateLockGateTests: XCTestCase {
    /// Records every request that reaches the "network" and answers from a script.
    final class Stub: URLProtocol {
        nonisolated(unsafe) static var seen: [URLRequest] = []
        nonisolated(unsafe) static var answer: (URLRequest) -> (Int, [String: String]) = { _ in (200, [:]) }
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            Self.seen.append(request)
            let (status, headers) = Self.answer(request)
            let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
            client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("{}".utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    private func session() -> URLSession {
        Stub.seen = []
        Stub.answer = { _ in (200, [:]) }
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [Stub.self]
        return URLSession(configuration: c)
    }

    override func tearDown() {
        UpdateLock.shared.set(false)
        super.tearDown()
    }

    func testPermitsOnlyReadsOfTheControlApex() {
        let apex = "flagshipserver.com"
        XCTAssertTrue(UpdateLock.permits(method: "GET", host: apex, controlHost: apex))
        XCTAssertTrue(UpdateLock.permits(method: nil, host: "FlagshipServer.com", controlHost: apex))
        XCTAssertTrue(UpdateLock.permits(method: "HEAD", host: apex, controlHost: apex))
        XCTAssertFalse(UpdateLock.permits(method: "POST", host: apex, controlHost: apex))
        XCTAssertFalse(UpdateLock.permits(method: "PUT", host: apex, controlHost: apex))
        XCTAssertFalse(UpdateLock.permits(method: "DELETE", host: apex, controlHost: apex))
        XCTAssertFalse(UpdateLock.permits(method: "GET", host: "home.bright-maple.flagship.services", controlHost: apex))
        XCTAssertFalse(UpdateLock.permits(method: "GET", host: "flagship.services", controlHost: apex))
        XCTAssertFalse(UpdateLock.permits(method: "GET", host: "evil-flagshipserver.com", controlHost: apex))
        XCTAssertFalse(UpdateLock.permits(method: "GET", host: nil, controlHost: apex))
    }

    func testUnlockedNothingIsRefused() async throws {
        let s = session()
        var post = URLRequest(url: URL(string: "https://home.u.flagship.services/api/screens/x")!)
        post.httpMethod = "POST"
        post.httpBody = Data("x".utf8)
        _ = try await s.gatedData(for: post)
        XCTAssertEqual(Stub.seen.count, 1)
    }

    func testLockedSendsNoWriteAndNoBoxCallButStillReadsTheControlApex() async throws {
        let s = session()
        UpdateLock.shared.set(true)
        var post = URLRequest(url: Endpoints.controlBaseUrl.appendingPathComponent("api/orders"))
        post.httpMethod = "POST"
        post.httpBody = Data("x".utf8)
        let box = URLRequest(url: URL(string: "https://home.bright-maple.flagship.services/api/screens/server-detail")!)
        let smuggled: URLRequest = {
            var r = URLRequest(url: Endpoints.controlBaseUrl.appendingPathComponent("api/orders"))
            r.httpMethod = "GET"
            r.httpBody = Data("x".utf8)
            return r
        }()
        for refused in [post, box, smuggled] {
            do {
                _ = try await s.gatedData(for: refused)
                XCTFail("should have been refused: \(refused.url!)")
            } catch let e as UpdateRequiredError {
                XCTAssertEqual(e.errorDescription, UpdateRequiredError.sentence)
            }
        }
        do {
            _ = try await s.gatedBytes(for: box)
            XCTFail("bytes should be refused")
        } catch is UpdateRequiredError {}
        XCTAssertThrowsError(try s.gatedWebSocketTask(with: URL(string: "wss://home.bright-maple.flagship.services/x")!))
        XCTAssertThrowsError(try s.gatedWebSocketTask(with: URLRequest(url: Endpoints.controlBaseUrl)))
        XCTAssertTrue(Stub.seen.isEmpty, "nothing left the app")

        _ = try await s.gatedData(for: URLRequest(url: Endpoints.controlBaseUrl.appendingPathComponent("api/health")))
        XCTAssertEqual(Stub.seen.count, 1)
        UpdateLock.shared.set(false)
        _ = try await s.gatedData(for: post)
        XCTAssertEqual(Stub.seen.count, 2)
    }

    /// The one gate: no client reaches the network any other way.
    func testNoClientSkipsTheGate() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var root: URL?
        for _ in 0..<14 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("apps/mobile/shared/Sources").path) { root = dir; break }
            dir = dir.deletingLastPathComponent()
        }
        guard let root else { throw XCTSkip("repo root not found") }
        // The two anonymous `.com` reads (the security notice, the relay addresses) must still leave while locked.
        let allowed: Set<String> = ["UpdateLock.swift", "SecurityNoticeCenter.swift", "RelayFallback.swift"]
        let pattern = try NSRegularExpression(pattern: #"\.(data\(for:|bytes\(for:|upload\(for:|download\(for:|webSocketTask\(with|dataTask\(|uploadTask\(|downloadTask\()"#)
        var offenders: [String] = []
        for sub in ["apps/mobile/shared/Sources", "apps/mobile/ios/Sources", "apps/mobile/ios/App/Sources"] {
            let en = FileManager.default.enumerator(at: root.appendingPathComponent(sub), includingPropertiesForKeys: nil)
            while let url = en?.nextObject() as? URL {
                if url.pathExtension != "swift" || allowed.contains(url.lastPathComponent) { continue }
                let text = try String(contentsOf: url, encoding: .utf8)
                for (i, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                    let s = String(line)
                    if s.trimmingCharacters(in: .whitespaces).hasPrefix("//") { continue }
                    if pattern.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil {
                        offenders.append("\(url.lastPathComponent):\(i + 1)")
                    }
                }
            }
        }
        XCTAssertEqual(offenders, [], "these requests skip the update lock's gate (use gatedData / gatedBytes / gatedWebSocketTask)")
    }

    // MARK: the notice fetch

    private func fetcher(_ answer: @escaping (URLRequest) -> (Int, [String: String])) -> AnonymousNoticeFetcher {
        Stub.seen = []
        Stub.answer = answer
        let c = AnonymousNoticeFetcher.anonymousConfiguration()
        c.protocolClasses = [Stub.self]
        return AnonymousNoticeFetcher(base: { URL(string: "https://flagshipserver.com")! }, configuration: c)
    }

    func testTheNoticeRequestCarriesNothingButAPlainGet() async throws {
        let f = fetcher { _ in (200, [:]) }
        let req = f.request()
        XCTAssertEqual(req.url?.absoluteString, "https://flagshipserver.com/api/notices")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertNil(req.url?.query)
        XCTAssertNil(req.url?.fragment)
        XCTAssertFalse(req.httpShouldHandleCookies)
        XCTAssertNil(req.httpBody)
        XCTAssertTrue((req.allHTTPHeaderFields ?? [:]).isEmpty, "no custom header")

        let result = await f.fetch()
        XCTAssertEqual(result, .document(Data("{}".utf8)))
        let seen = try XCTUnwrap(Stub.seen.first)
        let headers = (seen.allHTTPHeaderFields ?? [:]).keys.map { $0.lowercased() }
        for forbidden in ["cookie", "authorization", "referer", "origin"] {
            XCTAssertFalse(headers.contains(forbidden), forbidden)
        }
        XCTAssertFalse(headers.contains { $0.hasPrefix("x-flagship") })
        let cfg = AnonymousNoticeFetcher.anonymousConfiguration()
        XCTAssertNil(cfg.httpCookieStorage)
        XCTAssertNil(cfg.urlCredentialStorage)
        XCTAssertNil(cfg.urlCache)
        XCTAssertFalse(cfg.httpShouldSetCookies)
    }

    func testTheFetchAnswersAreFailOpen() async throws {
        let none = await fetcher { _ in (204, [:]) }.fetch()
        XCTAssertEqual(none, .none)
        let server = await fetcher { _ in (500, [:]) }.fetch()
        XCTAssertEqual(server, .failed)
        let moved = await fetcher { _ in (302, ["Location": "https://example.com/"]) }.fetch()
        XCTAssertEqual(moved, .failed, "a redirect is a failure")
    }

    @MainActor
    func testWatchApprovalIsPausedWhileLocked() async throws {
        let responder = WatchApprovalResponder(
            delegateEnrolled: { true }, hasSessionKey: { true },
            makeSource: { XCTFail("must not fetch while locked"); return nil },
            isPaused: { true }
        )
        let reply = await responder.respond(to: .init(requestId: "r1"))
        XCTAssertFalse(reply.ok)
        XCTAssertEqual(reply.errorMessage, WatchApprovalResponder.updateRequired)
    }
}
