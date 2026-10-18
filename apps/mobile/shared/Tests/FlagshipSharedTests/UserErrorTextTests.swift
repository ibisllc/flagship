import XCTest
@testable import FlagshipAPI

/// The raw failures a tester saw on the phone (Android) must never reach a
/// screen on iOS either: every one becomes a plain sentence, and a sentence
/// somebody wrote for people stays as written.
final class UserErrorTextTests: XCTestCase {

    private let rawStrings = [
        "connection closed",
        "HTTP 503: error code: 1102",
        "error code: 1102",
        "unable to resolve host \"flagshipserver.com\": No address associated with hostname",
        "Connection lost (NSURLErrorDomain -1005): The network connection was lost.",
        "The operation couldn't be completed. (NSURLErrorDomain error -1001.)",
        "Error Domain=NSURLErrorDomain Code=-1009 \"The Internet connection appears to be offline.\"",
        "java.net.SocketTimeoutException: timeout",
        "{\"error\":\"internal\"}",
        "<html>Bad gateway</html>",
        "unexpected end of stream",
        "nil",
    ]

    func test_noRawStringReachesAScreen() {
        for raw in rawStrings {
            let shown = UserErrorText.ofRaw(raw)
            XCTAssertNotEqual(shown, raw, raw)
            for leak in ["HTTP", "1102", "NSURL", "Domain", "java.", "resolve host", "closed", "{", "<html"] {
                XCTAssertFalse(shown.contains(leak), "\(raw) -> \(shown) leaks \(leak)")
            }
            XCTAssertTrue(shown.first?.isUppercase == true && ".!?".contains(shown.last!), shown)
        }
    }

    func test_eachFamilyHasItsOwnSentence() {
        XCTAssertEqual(UserErrorText.ofRaw("connection closed"), UserErrorText.dropped)
        XCTAssertEqual(UserErrorText.ofRaw("unexpected end of stream"), UserErrorText.dropped)
        XCTAssertEqual(UserErrorText.ofRaw("HTTP 503: error code: 1102"), UserErrorText.serverProblem)
        XCTAssertEqual(UserErrorText.ofRaw("HTTP 524: error code: 524"), UserErrorText.serverProblem)
        XCTAssertEqual(UserErrorText.ofRaw("timeout"), UserErrorText.timeout)
        XCTAssertEqual(UserErrorText.ofRaw("Read timed out"), UserErrorText.timeout)
        XCTAssertEqual(UserErrorText.ofRaw("unable to resolve host \"x\""), UserErrorText.offline)
        XCTAssertEqual(UserErrorText.ofRaw("error code: 1102"), UserErrorText.generic)
        XCTAssertEqual(UserErrorText.ofRaw(""), UserErrorText.generic)
        XCTAssertEqual(UserErrorText.ofRaw(nil), UserErrorText.generic)
    }

    func test_aSentenceWrittenForPeopleStays() {
        XCTAssertEqual(UserErrorText.ofRaw("Pick a name first."), "Pick a name first.")
        XCTAssertEqual(
            UserErrorText.ofRaw("That name is taken. Try another."),
            "That name is taken. Try another."
        )
    }

    func test_aShellLineNumberIsStripped() {
        XCTAssertEqual(
            UserErrorText.ofRaw("Setup stopped while Expanding the disk to 68 GB (line 66)"),
            "Setup stopped while Expanding the disk to 68 GB"
        )
        XCTAssertEqual(UserErrorText.stripInternals("Failed at line 12: no space"), "Failed: no space")
    }

    func test_urlErrorsBecomeSentences() {
        XCTAssertEqual(UserErrorText.of(URLError(.timedOut)), UserErrorText.timeout)
        XCTAssertEqual(UserErrorText.of(URLError(.networkConnectionLost)), UserErrorText.dropped)
        XCTAssertEqual(UserErrorText.of(URLError(.cannotConnectToHost)), UserErrorText.offline)
        XCTAssertEqual(UserErrorText.of(URLError(.cannotFindHost)), UserErrorText.nameLookup)
        XCTAssertEqual(UserErrorText.of(URLError(.dnsLookupFailed)), UserErrorText.nameLookup)
        XCTAssertFalse(UserErrorText.nameLookup.contains("Couldn't reach the server"))
        XCTAssertEqual(UserErrorText.of(URLError(.notConnectedToInternet)), "You're offline. Check your connection and try again.")
        let ns = NSError(domain: NSURLErrorDomain, code: NSURLErrorDNSLookupFailed)
        XCTAssertEqual(UserErrorText.of(ns), UserErrorText.nameLookup)
        let posix = NSError(domain: NSPOSIXErrorDomain, code: Int(ECONNRESET))
        XCTAssertEqual(UserErrorText.of(posix), UserErrorText.dropped)
    }

    func test_anUnknownErrorIsAHonestGenericSentenceNotAConnectionClaim() {
        struct Odd: Error {}
        XCTAssertEqual(UserErrorText.of(Odd()), UserErrorText.generic)
        XCTAssertFalse(UserErrorText.of(Odd()).lowercased().contains("connection"))
    }

    func test_aRefusalShowsTheBoxsOwnSentence() {
        let e = ScreensClientError.http(status: 409, message: #"{"error":"That app name is already used on this server."}"#)
        XCTAssertEqual(e.errorDescription, "That app name is already used on this server.")
        XCTAssertEqual(UserErrorText.of(e), "That app name is already used on this server.")
    }

    func test_aRefusalWithNoReadableReasonDoesNotBlameTheConnection() {
        for body in ["", "forbidden", #"{"error":"not-found"}"#, "<html>nope</html>"] {
            let e = ScreensClientError.http(status: 422, message: body)
            let shown = e.errorDescription ?? ""
            XCTAssertEqual(shown, UserErrorText.refused, body)
            XCTAssertFalse(shown.lowercased().contains("connection"))
        }
    }

    func test_knownComReasonsAreRewritten() {
        let rck = ScreensClientError.http(status: 409, message: #"{"error":"subdomain already controlled by a different RCK"}"#)
        XCTAssertTrue((rck.errorDescription ?? "").contains("earlier, unfinished order"))
        let stale = ScreensClientError.http(status: 400, message: #"{"error":"stale request"}"#)
        XCTAssertTrue((stale.errorDescription ?? "").contains("clock"))
    }

    func test_serverErrorsAreServerProblemsWhateverTheBodySays() {
        let e = ScreensClientError.http(status: 503, message: "error code: 1102")
        XCTAssertEqual(e.errorDescription, UserErrorText.serverProblem)
        let e2 = ScreensClientError.http(status: 502, message: #"{"error":"Upstream exploded."}"#)
        XCTAssertEqual(e2.errorDescription, UserErrorText.serverProblem)
    }

    func test_builderRelayLossIsPlain() {
        let e = BuilderPairError.connectionFailed("Connection lost (NSURLErrorDomain -1005): The network connection was lost.")
        XCTAssertEqual(e.errorDescription, UserErrorText.dropped)
    }
}
