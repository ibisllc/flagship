import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI

final class AuthCodeCancelTests: XCTestCase {

    func test_canonicalBytes_followsV1Format() {
        let s = String(
            data: AuthCodeCancel.canonicalBytes(serial: "01ABCD", username: "harry", issuedAt: 42),
            encoding: .utf8
        )
        XCTAssertEqual(s, "flagship/auth-code-cancel/v1|01ABCD|harry|42")
    }

    func test_signatureVerifiesUnderIrkPublicKey() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let bytes = AuthCodeCancel.canonicalBytes(serial: "01XYZ", username: "harry", issuedAt: 1)
        let sig = try irk.signature(for: bytes)
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: bytes))
    }

    func test_mockServer_storesCancelledSerials() async throws {
        let c = MockFlagshipServerClient()
        c.simulatedLatency = 0
        try await c.cancelAuthCode(.init(
            request: .init(serial: "01CAFE", username: "harry", issuedAt: 1),
            signature: "deadbeef"
        ))
        XCTAssertTrue(c.cancelledAuthCodes.contains("01CAFE"))
    }

    func test_mockServer_cancelIsIdempotent() async throws {
        let c = MockFlagshipServerClient()
        c.simulatedLatency = 0
        let req = AuthCodeCancelRequest(
            request: .init(serial: "01DUP", username: "harry", issuedAt: 1),
            signature: "x"
        )
        try await c.cancelAuthCode(req)
        try await c.cancelAuthCode(req)
        XCTAssertEqual(c.cancelledAuthCodes.intersection(["01DUP"]).count, 1)
    }
}
