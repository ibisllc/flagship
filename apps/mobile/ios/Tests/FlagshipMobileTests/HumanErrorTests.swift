import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// UX-A + UX-B — `HumanError` is a PURE STATIC mapping from a caught error
/// shape to plain-language copy. These tests pin: equivalent error classes get
/// equivalent categories (parity with Android's NetworkErrorHumanizer + the
/// webapp humanError.js), the cert-pin case stays its own loud category, and a
/// raw status / Apple developer string is NEVER leaked to the user.
final class HumanErrorTests: XCTestCase {

    // MARK: - ScreensClientError bridge (the canonical wire-error copy)

    func testCertPinMismatchIsItsOwnLoudCategory() {
        let (kind, msg) = HumanError.classify(
            ScreensClientError.certPinMismatch(host: "blog.box.user.flagship.services")
        )
        XCTAssertEqual(kind, .certPinMismatch)
        XCTAssertTrue(msg.lowercased().contains("intercepting"))
        XCTAssertTrue(HumanError.isCertPinMismatch(
            ScreensClientError.certPinMismatch(host: "x")
        ))
    }

    func testHttp5xxIsServerProblemAndHidesTheCode() {
        let (kind, msg) = HumanError.classify(
            ScreensClientError.http(status: 503, message: "upstream boom")
        )
        XCTAssertEqual(kind, .serverProblem)
        XCTAssertFalse(msg.contains("503"))
        XCTAssertFalse(msg.contains("boom"))
    }

    func testHttp4xxIsRequestProblemAndHidesTheCode() {
        let (kind, msg) = HumanError.classify(
            ScreensClientError.http(status: 404, message: "not found")
        )
        XCTAssertEqual(kind, .requestProblem)
        XCTAssertFalse(msg.contains("404"))
    }

    func testHttpStatusZeroReadsAsOffline() {
        let (kind, _) = HumanError.classify(ScreensClientError.http(status: 0, message: ""))
        XCTAssertEqual(kind, .offline)
    }

    func testNotPairedIsAPlainRequestProblem() {
        let (kind, msg) = HumanError.classify(ScreensClientError.notPaired)
        XCTAssertEqual(kind, .requestProblem)
        XCTAssertFalse(msg.isEmpty)
    }

    func testDecodingScreensErrorIsRequestProblem() {
        let (kind, msg) = HumanError.classify(ScreensClientError.decoding("Optional<Foo>"))
        XCTAssertEqual(kind, .requestProblem)
        XCTAssertFalse(msg.contains("Foo"))
    }

    // MARK: - URLError mapping

    func testOfflineUrlErrorReadsAsOffline() {
        let (kind, msg) = HumanError.classify(URLError(.notConnectedToInternet))
        XCTAssertEqual(kind, .offline)
        XCTAssertTrue(msg.lowercased().contains("offline"))
    }

    func testTimeoutUrlErrorReadsAsOffline() {
        let (kind, msg) = HumanError.classify(URLError(.timedOut))
        XCTAssertEqual(kind, .offline)
        XCTAssertTrue(msg.lowercased().contains("timed out"))
    }

    func testBadServerResponseReadsAsServerProblem() {
        let (kind, _) = HumanError.classify(URLError(.badServerResponse))
        XCTAssertEqual(kind, .serverProblem)
    }

    /// NSURLErrorCancelled is how URLSession reports a cert-pin hard-fail (the
    /// delegate cancels the auth challenge). When the mismatch sink flagged the
    /// failing host, a cancelled URLError must surface the interception warning
    /// — NOT a generic "offline".
    func testCancelledUrlErrorWithRecordedMismatchSurfacesInterception() {
        let host = "blog.box.alice.flagship.services"
        CertPinMismatchSink.shared.clear()
        CertPinMismatchSink.shared.record(host: host)
        let err = URLError(
            .cancelled,
            userInfo: [NSURLErrorFailingURLStringErrorKey: "https://\(host)/api/screens/apps-list"]
        )
        let (kind, msg) = HumanError.classify(err)
        XCTAssertEqual(kind, .certPinMismatch)
        XCTAssertTrue(msg.lowercased().contains("intercepting"))
        CertPinMismatchSink.shared.clear()
    }

    /// A cancelled URLError with NO recorded mismatch must NOT be over-alarmed
    /// as interception — it's an ordinary cancellation/offline.
    func testCancelledUrlErrorWithoutMismatchIsNotInterception() {
        CertPinMismatchSink.shared.clear()
        let (kind, msg) = HumanError.classify(URLError(.cancelled))
        XCTAssertEqual(kind, .offline)
        XCTAssertFalse(msg.lowercased().contains("intercepting"))
    }

    // MARK: - Fallbacks + the no-leak guarantee

    func testDecodingErrorIsRequestProblem() {
        let ctx = DecodingError.Context(codingPath: [], debugDescription: "kaboom internals")
        let (kind, msg) = HumanError.classify(DecodingError.dataCorrupted(ctx))
        XCTAssertEqual(kind, .requestProblem)
        XCTAssertFalse(msg.contains("kaboom"))
    }

    func testUnknownErrorGetsGenericCopyNotItsRawText() {
        struct Weird: Error { let detail = "stack-trace-ish internal detail" }
        let (kind, msg) = HumanError.classify(Weird())
        XCTAssertEqual(kind, .unknown)
        XCTAssertFalse(msg.contains("stack-trace"))
        XCTAssertFalse(msg.contains("internal"))
    }

    /// The core UX-B guarantee across every category: the user-facing string
    /// never contains a raw HTTP status token or an obvious developer leak.
    func testNeverLeaksARawStatusToken() {
        let cases: [Error] = [
            ScreensClientError.http(status: 500, message: "x"),
            ScreensClientError.http(status: 404, message: "x"),
            ScreensClientError.http(status: 401, message: "x"),
            ScreensClientError.certPinMismatch(host: "h"),
            URLError(.timedOut),
            URLError(.notConnectedToInternet),
            DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "d")),
        ]
        for e in cases {
            let msg = HumanError.humanize(e)
            XCTAssertNil(
                msg.range(of: #"HTTP \d"#, options: .regularExpression),
                "leaked a raw HTTP status token: \(msg)"
            )
        }
    }

    func testHumanizeConvenienceMatchesClassifyMessage() {
        let e = ScreensClientError.http(status: 502, message: "x")
        XCTAssertEqual(HumanError.humanize(e), HumanError.classify(e).message)
    }
}
