import XCTest
@testable import FlagshipUI

/// Privacy policy §2.12: the device's call-room URL names only the call, never the account. Mirrors Android
/// VoiciCallRoomUrlTest.
final class VoiciCallRoomURLTests: XCTestCase {
    func test_theRoomURLNamesOnlyTheCall() throws {
        let callId = "0123456789abcdef0123456789abcdef"
        let url = try XCTUnwrap(VoiciCallSession.roomURL(room: "flagshipserver.com", callId: callId))
        XCTAssertEqual(url.absoluteString, "wss://flagshipserver.com/api/voici/calls/\(callId)/device")
        XCTAssertNil(url.query)
    }
}
