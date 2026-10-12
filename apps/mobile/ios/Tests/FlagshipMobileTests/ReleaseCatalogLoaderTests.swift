import XCTest
@testable import FlagshipCore
@testable import FlagshipAPI

final class ReleaseCatalogLoaderTests: XCTestCase {
    private let current = "1234567890abcdef1234567890abcdef12345678"
    private let newer = "9f2c1ab3de4567890abcdef1234567890abcdef1"
    private let base = URL(string: "https://control.example")!

    private func box(failing status: Int? = nil) -> MockScreensClient {
        let m = MockScreensClient()
        m.simulatedLatency = 0
        m.simulatedFailureStatus = status
        return m
    }

    private var comBody: String {
        """
        {"checkedAt":1760227200000,"currentCommit":"\(current)",\
        "latest":{"commit":"\(newer)","releaseId":"r2","tag":"v0.0.0-2026-10-11-9f2c1ab3","endorsedAt":"2026-10-11T12:00:00.000Z","relation":"newer"},\
        "releases":[\
        {"commit":"\(newer)","releaseId":"r2","tag":"v0.0.0-2026-10-11-9f2c1ab3","endorsedAt":"2026-10-11T12:00:00.000Z","relation":"newer"},\
        {"commit":"\(current)","releaseId":"r1","tag":"v0.0.0-2026-10-10-12345678","endorsedAt":"2026-10-10T12:00:00.000Z","relation":"current"}],\
        "source":"flagship"}
        """
    }

    private func com(status: Int = 200, body: String? = nil, seen: @escaping (URLRequest) -> Void) -> LiveSecretMailboxClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let payload = body ?? comBody
        StubURLProtocol.handler = { req in
            seen(req)
            let resp = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            return (resp, Data(payload.utf8))
        }
        return LiveSecretMailboxClient(urlSession: URLSession(configuration: config), baseUrl: base)
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    func testBox404AsksComForTheBoxCommit() async throws {
        var urls: [String] = []
        let mailbox = com { urls.append($0.url!.absoluteString) }
        let catalog = try await ReleaseCatalogLoader.load(
            screens: box(failing: 404), mailbox: mailbox, currentCommit: current, refresh: false)
        XCTAssertEqual(urls, ["https://control.example/api/releases?current=\(current)"])
        XCTAssertEqual(catalog.latest?.commit, newer)
        XCTAssertEqual(catalog.currentCommit, current)
        XCTAssertEqual(catalog.releases.map(\.relation), ["newer", "current"])
        XCTAssertNil(catalog.stale)
    }

    func testBox404RefreshPassesRefreshToCom() async throws {
        var urls: [String] = []
        let mailbox = com { urls.append($0.url!.absoluteString) }
        _ = try await ReleaseCatalogLoader.load(
            screens: box(failing: 404), mailbox: mailbox, currentCommit: current, refresh: true)
        XCTAssertEqual(urls, ["https://control.example/api/releases?current=\(current)&refresh=1"])
    }

    func testBox502IsThrownAndComNotAsked() async {
        let mailbox = MockSecretMailboxClient()
        do {
            _ = try await ReleaseCatalogLoader.load(
                screens: box(failing: 502), mailbox: mailbox, currentCommit: current, refresh: false)
            XCTFail("expected the box error")
        } catch ScreensClientError.http(let status, _) {
            XCTAssertEqual(status, 502)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertTrue(mailbox.releaseCatalogRequests.isEmpty)
    }

    func testBox404WithoutReportedCommitIsThrownAndComNotAsked() async {
        let mailbox = MockSecretMailboxClient()
        for commit in [nil, "", "9f2c1ab3"] as [String?] {
            do {
                _ = try await ReleaseCatalogLoader.load(
                    screens: box(failing: 404), mailbox: mailbox, currentCommit: commit, refresh: false)
                XCTFail("expected the box error")
            } catch ScreensClientError.http(let status, _) {
                XCTAssertEqual(status, 404)
            } catch {
                XCTFail("unexpected \(error)")
            }
        }
        XCTAssertTrue(mailbox.releaseCatalogRequests.isEmpty)
    }

    func testBoxOkIsUsedAndComNotAsked() async throws {
        let mailbox = MockSecretMailboxClient()
        let screens = box()
        let catalog = try await ReleaseCatalogLoader.load(
            screens: screens, mailbox: mailbox, currentCommit: current, refresh: true)
        let fromBox = try await screens.serverUpdates(refresh: true)
        XCTAssertEqual(catalog.latest, fromBox.latest)
        XCTAssertEqual(catalog.releases, fromBox.releases)
        XCTAssertTrue(mailbox.releaseCatalogRequests.isEmpty)
    }

    func testComErrorSurfacesItsStatus() async {
        let mailbox = com(status: 502, body: #"{"error":"GitHub unavailable"}"#) { _ in }
        do {
            _ = try await ReleaseCatalogLoader.load(
                screens: box(failing: 404), mailbox: mailbox, currentCommit: current, refresh: false)
            XCTFail("expected the .com error")
        } catch ScreensClientError.http(let status, let message) {
            XCTAssertEqual(status, 502)
            XCTAssertTrue(message.contains("GitHub unavailable"))
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testMockMailboxRecordsTheFallbackRequest() async throws {
        let mailbox = MockSecretMailboxClient()
        let catalog = try await ReleaseCatalogLoader.load(
            screens: box(failing: 404), mailbox: mailbox, currentCommit: current.uppercased(), refresh: true)
        XCTAssertEqual(mailbox.releaseCatalogRequests.map(\.currentCommit), [current])
        XCTAssertEqual(mailbox.releaseCatalogRequests.map(\.refresh), [true])
        XCTAssertNil(catalog.latest)
    }
}
