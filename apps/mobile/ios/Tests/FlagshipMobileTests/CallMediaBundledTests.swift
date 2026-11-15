#if os(iOS)
import XCTest
@testable import FlagshipUI

/// The calls media lane (.github/workflows/libwebrtc.yml): with Vendor/WebRTC present, FlagshipUI links our libwebrtc
/// and the TURN responder. The lane sets FLAGSHIP_EXPECT_WEBRTC=1, so a build that silently fell back to the stub fails.
final class CallMediaBundledTests: XCTestCase {
    private var expected: Bool { ProcessInfo.processInfo.environment["FLAGSHIP_EXPECT_WEBRTC"] == "1" }

    func testTheRealEngineIsLinkedWhenTheLibrariesArePresent() throws {
        if expected { XCTAssertTrue(CallMediaFactory.bundled) }
        try XCTSkipUnless(CallMediaFactory.bundled, "built without Vendor/WebRTC")
        XCTAssertFalse(CallMediaFactory.make() is StubCallMediaEngine)
    }

    func testTheTurnResponderAnswersABindingAndRefusesHttp() throws {
        try XCTSkipUnless(CallMediaFactory.bundled, "built without Vendor/WebRTC")
        XCTAssertTrue(CallMediaFactory.turnSelfTest())
    }
}
#endif
