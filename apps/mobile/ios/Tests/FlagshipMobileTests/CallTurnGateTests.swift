import XCTest
@testable import Flagship

/// The bare-name endpoint's demux for a call's TURN stream (docs/voici-calls.md §4). Mirrors Android CallTurnGateTest.
final class CallTurnGateTests: XCTestCase {
    private final class Echo: CallTurnConnection {
        func onClientBytes(_ data: Data) -> [Data]? { [data] }
        func close() {}
    }

    func test_firstByteRule() {
        XCTAssertEqual(CallTurnGate.route(firstByte: 0x00, turnReady: true), .turn)
        XCTAssertEqual(CallTurnGate.route(firstByte: 0x01, turnReady: false), .close)
        XCTAssertEqual(CallTurnGate.route(firstByte: UInt8(ascii: "G"), turnReady: true), .http)
        XCTAssertEqual(CallTurnGate.route(firstByte: 0x40, turnReady: true), .http)
    }

    func test_turnOnlyWhileArmedOnceAndLinked() {
        let gate = CallTurnGate()
        XCTAssertEqual(gate.open(firstByte: 0).route, .close)
        gate.arm(.init(user: String(repeating: "u", count: 32), secret: String(repeating: "s", count: 64)))
        XCTAssertEqual(gate.open(firstByte: 0).route, .close, "no responder linked: closed")
        var made: CallTurnGate.Credential?
        gate.factory = { made = $0; return Echo() }
        let first = gate.open(firstByte: 0)
        XCTAssertEqual(first.route, .turn)
        XCTAssertNotNil(first.connection)
        XCTAssertEqual(made?.user, String(repeating: "u", count: 32))
        XCTAssertEqual(gate.open(firstByte: 0).route, .close, "one TURN connection per call")
        XCTAssertEqual(gate.open(firstByte: UInt8(ascii: "P")).route, .http)
        gate.disarm()
        XCTAssertFalse(gate.isArmed)
        XCTAssertEqual(gate.open(firstByte: 0).route, .close)
    }
}
