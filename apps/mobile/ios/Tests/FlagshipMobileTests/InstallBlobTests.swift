import XCTest
import CryptoKit
@testable import Flagship

final class InstallBlobTests: XCTestCase {

    // MARK: - Canonical bytes

    func test_installBlobCanonicalBytes_followsPipeSeparatedV1Format() {
        let auth = AuthCode(
            serial: "01ABCD",
            username: "harry",
            serverName: "home",
            serverDomain: "home.harry.flagship.services",
            delegatedPubKey: Data(repeating: 0x11, count: 32),
            userPubKey: Data(repeating: 0x22, count: 32),
            issuedAt: 1,
            expiresAt: 2
        )
        let blob = InstallBlob(
            serverDomain: "home.harry.flagship.services",
            username: "harry",
            serverName: "home",
            phoneDelegatedPubKey: Data(repeating: 0x33, count: 32),
            authCode: auth,
            authCodeUserSignature: Data(repeating: 0x44, count: 64),
            issuedAt: 1,
            expiresAt: 2,
            rckPubKey: Data(repeating: 0x55, count: 32)
        )
        let s = String(data: blob.canonicalBytes(), encoding: .utf8)!
        // Must start with the canonical tag, must be pipe-separated.
        XCTAssertTrue(s.hasPrefix("flagship/install-blob/v1|1|home.harry.flagship.services|harry|home|"))
        XCTAssertTrue(s.contains("\(String(repeating: "33", count: 32))|"))   // phoneDelegatedPubKey hex
        XCTAssertTrue(s.contains("|01ABCD|"))                                  // authCode serial
        XCTAssertTrue(s.contains("|\(String(repeating: "55", count: 32))"))   // rckPubKey trailing
    }

    func test_authCodeCanonicalBytes_followsV1Format() {
        let auth = AuthCode(
            serial: "01XYZ",
            username: "harry",
            serverName: "home",
            serverDomain: "home.harry.flagship.services",
            delegatedPubKey: Data(repeating: 0x11, count: 32),
            userPubKey: Data(repeating: 0x22, count: 32),
            issuedAt: 1234,
            expiresAt: 5678
        )
        let s = String(data: auth.canonicalBytes(), encoding: .utf8)!
        XCTAssertEqual(
            s,
            "flagship/auth-code/v1|1|01XYZ|harry|home|home.harry.flagship.services|" +
            String(repeating: "11", count: 32) + "|" +
            String(repeating: "22", count: 32) + "|1234|5678"
        )
    }

    func test_usernameClaimCanonicalBytes_followsV1Format() {
        let s = String(
            data: UsernameClaim.canonicalBytes(username: "harry", irkPubHex: "abcd", issuedAt: 42),
            encoding: .utf8
        )!
        XCTAssertEqual(s, "flagship/claim-username/v1|harry|abcd|42")
    }

    func test_pushTokenRegisterCanonicalBytes_followsV1Format() {
        let s = String(
            data: PushTokenRegister.canonicalBytes(
                username: "harry",
                platform: "apns",
                providerToken: "deadbeef",
                pushX25519PubHex: String(repeating: "ab", count: 32),
                issuedAt: 1700000000
            ),
            encoding: .utf8
        )!
        XCTAssertEqual(
            s,
            "flagship/push-token-register/v1|harry|apns|deadbeef|" +
            String(repeating: "ab", count: 32) + "|1700000000"
        )
    }

    func test_authCodeRevokeCanonicalBytes_followsV1Format() {
        let s = String(
            data: AuthCodeRevoke.canonicalBytes(serial: "01ABCD", username: "harry", issuedAt: 7),
            encoding: .utf8
        )!
        XCTAssertEqual(s, "flagship/auth-code-revoke/v1|01ABCD|harry|7")
    }

    func test_rckRegisterCanonicalBytes_followsV1Format() {
        let s = String(
            data: RckRegister.canonicalBytes(
                username: "harry",
                subdomain: "home.harry.flagship.services",
                rckPubHex: "deadbeef",
                issuedAt: 99
            ),
            encoding: .utf8
        )!
        XCTAssertEqual(s, "flagship/rck-register/v1|harry|home.harry.flagship.services|deadbeef|99")
    }

    // MARK: - Signing round-trip

    func test_signedInstallBlobVerifiesUnderIrkPublic() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let auth = AuthCode(
            serial: "01CAFE",
            username: "harry",
            serverName: "home",
            serverDomain: "home.harry.flagship.services",
            delegatedPubKey: Data(repeating: 0x10, count: 32),
            userPubKey: irk.publicKey.rawRepresentation,
            issuedAt: 1,
            expiresAt: 2
        )
        let blob = InstallBlob(
            serverDomain: "home.harry.flagship.services",
            username: "harry",
            serverName: "home",
            phoneDelegatedPubKey: Data(repeating: 0x10, count: 32),
            authCode: auth,
            authCodeUserSignature: try irk.signature(for: auth.canonicalBytes()),
            issuedAt: 1,
            expiresAt: 2,
            rckPubKey: Data(repeating: 0x50, count: 32)
        )
        let sig = try irk.signature(for: blob.canonicalBytes())
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: blob.canonicalBytes()))
    }

    // MARK: - HexUtil + SerialGen

    func test_hexRoundTrip() {
        let raw = Data((0..<256).map { UInt8($0) })
        let hex = HexUtil.encode(raw)
        XCTAssertEqual(hex.count, 512)
        XCTAssertEqual(HexUtil.decode(hex), raw)
    }

    func test_hexDecodeRejectsOddLengthAndNonHex() {
        XCTAssertNil(HexUtil.decode("abc"))
        XCTAssertNil(HexUtil.decode("zz"))
    }

    func test_serialGen_returnsExactly22HexCharsPrefixed01() {
        // Matches genSerial() in create-server.js — "01" + 10 random
        // bytes hexlified = 22 chars (the `.slice(0, 26)` in JS is a
        // no-op at that length).
        for _ in 0..<10 {
            let s = SerialGen.random()
            XCTAssertEqual(s.count, 22)
            XCTAssertTrue(s.hasPrefix("01"))
            XCTAssertNotNil(HexUtil.decode(s.lowercased()))
        }
    }
}
