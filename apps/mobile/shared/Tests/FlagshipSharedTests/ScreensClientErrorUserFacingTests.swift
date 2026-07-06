import XCTest
@testable import FlagshipAPI

/// UX-B — surfaces that show a caught error to the user must route it
/// through `ScreensClientError.userFacing` so a normal person never sees a
/// raw enum case (`noSessionToken`), an HTTP status, or Apple's
/// developer-facing `localizedDescription`. VibeCodeChatScreen previously
/// showed `String(describing: error)` at five sites — this pins the mapping
/// those sites now use.
final class ScreensClientErrorUserFacingTests: XCTestCase {
    private struct RawError: Error { let detail = "noSessionToken" }

    func testTypedErrorYieldsPlainLanguage() {
        let msg = ScreensClientError.userFacing(ScreensClientError.noSessionToken)
        XCTAssertEqual(msg, "Your connection to this box expired. Reconnect and try again.")
        // The raw enum-case name must never reach the user.
        XCTAssertFalse(msg.contains("noSessionToken"))
        XCTAssertFalse(msg.contains("ScreensClientError"))
    }

    func testHttpStatusIsNotLeaked() {
        let msg = ScreensClientError.userFacing(
            ScreensClientError.http(status: 502, message: "upstream boom")
        )
        XCTAssertFalse(msg.contains("502"))
        XCTAssertFalse(msg.contains("upstream boom"))
    }

    func testUntypedErrorCollapsesToGenericFallback() {
        // A raw transport error (or anything non-ScreensClientError) must
        // collapse to one honest sentence, never `String(describing:)`.
        let msg = ScreensClientError.userFacing(RawError())
        XCTAssertEqual(msg, "Couldn't reach the server. Check your connection and try again.")
        XCTAssertFalse(msg.contains("RawError"))
        XCTAssertFalse(msg.contains("noSessionToken"))
    }
}
