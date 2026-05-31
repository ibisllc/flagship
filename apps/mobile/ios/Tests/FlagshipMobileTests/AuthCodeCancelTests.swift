import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore
@testable import FlagshipAPI

final class AuthCodeRevokeTests: XCTestCase {

    func test_canonicalBytes_followsV1Format() {
        let s = String(
            data: AuthCodeRevoke.canonicalBytes(serial: "01ABCD", username: "harry", issuedAt: 42),
            encoding: .utf8
        )
        // Must match packages/protocol/src/auth.ts canonicalAuthCodeRevoke
        // exactly so iOS-signed envelopes verify on the .com side.
        XCTAssertEqual(s, "flagship/auth-code-revoke/v1|01ABCD|harry|42")
    }

    func test_signatureVerifiesUnderIrkPublicKey() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let bytes = AuthCodeRevoke.canonicalBytes(serial: "01XYZ", username: "harry", issuedAt: 1)
        let sig = try irk.signature(for: bytes)
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: bytes))
    }

    func test_mockServer_storesRevokedSerials() async throws {
        let c = MockFlagshipServerClient()
        c.simulatedLatency = 0
        try await c.revokeAuthCode(.init(
            request: .init(serial: "01CAFE", username: "harry", issuedAt: 1),
            signature: "deadbeef"
        ))
        XCTAssertTrue(c.revokedAuthCodes.contains("01CAFE"))
    }

    func test_mockServer_revokeIsIdempotent() async throws {
        let c = MockFlagshipServerClient()
        c.simulatedLatency = 0
        let req = AuthCodeRevokeRequest(
            request: .init(serial: "01DUP", username: "harry", issuedAt: 1),
            signature: "x"
        )
        try await c.revokeAuthCode(req)
        try await c.revokeAuthCode(req)
        XCTAssertEqual(c.revokedAuthCodes.intersection(["01DUP"]).count, 1)
    }
}
