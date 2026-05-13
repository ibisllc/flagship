import XCTest
@testable import FlagshipAPI

final class QrRelayClientTests: XCTestCase {

    func test_mockHelloAndDeliverHappyPath() async throws {
        let r = MockQrRelayClient()
        try await r.openAndHello(sid: "test-sid", phonePkBase64Url: "AAAA")
        XCTAssertEqual(r.lastHello?.sid, "test-sid")
        try await r.deliver(ciphertextBase64Url: "CT", nonceBase64Url: "NONCE")
        XCTAssertEqual(r.lastDeliver?.ciphertext, "CT")
    }

    func test_mockPeerMissingThrows() async {
        let r = MockQrRelayClient()
        r.behavior = .peerMissing
        do {
            try await r.openAndHello(sid: "x", phonePkBase64Url: "y")
            XCTFail("expected throw")
        } catch QrRelayError.peerMissing {
            // ok
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    func test_mockSessionExpiredOnDeliver() async {
        let r = MockQrRelayClient()
        r.behavior = .sessionExpired
        do {
            try await r.deliver(ciphertextBase64Url: "x", nonceBase64Url: "y")
            XCTFail("expected throw")
        } catch QrRelayError.sessionExpired {
            // ok
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    func test_mockRelayErrorPropagatesReason() async {
        let r = MockQrRelayClient()
        r.behavior = .relayError("bad pubkey")
        do {
            try await r.openAndHello(sid: "x", phonePkBase64Url: "y")
            XCTFail("expected throw")
        } catch QrRelayError.relayError(let reason) {
            XCTAssertEqual(reason, "bad pubkey")
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }
}
