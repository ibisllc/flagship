import XCTest
@testable import FlagshipUI

/// The caller checks the callee phone's TURN certificate with the system's roots and the exact dialled name.
final class TurnCertCheckTests: XCTestCase {
    func test_theHostComesFromTheTurnUrl() {
        XCTAssertEqual(TurnCertCheck.host(ofTurnUrl: "turns:Brisk-Quartz.flagship.services:443?transport=tcp"), "brisk-quartz.flagship.services")
        XCTAssertNil(TurnCertCheck.host(ofTurnUrl: "turn:brisk-quartz.flagship.services:443"))
        XCTAssertNil(TurnCertCheck.host(ofTurnUrl: "turns::443"))
    }

    func test_garbageIsRefused() {
        XCTAssertFalse(TurnCertCheck.evaluate(Data([1, 2, 3]), host: "brisk-quartz.flagship.services"))
    }
}
