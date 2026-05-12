import XCTest
import CryptoKit
@testable import Flagship

final class BootApprovalTests: XCTestCase {

    func test_canonicalBytes_isPipeSeparatedV1() {
        let claim = BootApproval(
            requestId: "req-1",
            serverFqdn: "home.harry.flagship.services",
            requestedAt: 1_700_000_000_000,
            approvedAt: 1_700_000_001_000
        )
        let s = String(data: claim.canonicalBytes(), encoding: .utf8)
        XCTAssertEqual(
            s,
            "flagship/boot-approval/v1|home.harry.flagship.services|req-1|1700000000000|1700000001000"
        )
    }

    func test_signedClaimVerifiesWithMatchingPublicKey() throws {
        let bak = Curve25519.Signing.PrivateKey()
        let claim = BootApproval(
            requestId: "req-1",
            serverFqdn: "home.harry.flagship.services",
            requestedAt: 1, approvedAt: 2
        )
        let signed = try claim.sign(with: bak)
        XCTAssertTrue(BootApproval.verify(
            envelopeBase64: signed.envelopeBase64,
            signatureHex: signed.signatureHex,
            publicKey: bak.publicKey
        ))
    }

    func test_signedClaimFailsWithDifferentKey() throws {
        let bak = Curve25519.Signing.PrivateKey()
        let other = Curve25519.Signing.PrivateKey()
        let claim = BootApproval(
            requestId: "req-1",
            serverFqdn: "home.harry.flagship.services",
            requestedAt: 1, approvedAt: 2
        )
        let signed = try claim.sign(with: bak)
        XCTAssertFalse(BootApproval.verify(
            envelopeBase64: signed.envelopeBase64,
            signatureHex: signed.signatureHex,
            publicKey: other.publicKey
        ))
    }

    func test_tamperedEnvelopeFailsVerification() throws {
        let bak = Curve25519.Signing.PrivateKey()
        let claim = BootApproval(
            requestId: "req-1",
            serverFqdn: "home.harry.flagship.services",
            requestedAt: 1, approvedAt: 2
        )
        let signed = try claim.sign(with: bak)

        // Forge a different envelope but reuse the original signature.
        let forged = BootApproval(
            requestId: "req-2",
            serverFqdn: "home.harry.flagship.services",
            requestedAt: 1, approvedAt: 2
        )
        let forgedEnv = try JSONEncoder().encode(forged).base64EncodedString()
        XCTAssertFalse(BootApproval.verify(
            envelopeBase64: forgedEnv,
            signatureHex: signed.signatureHex,
            publicKey: bak.publicKey
        ))
    }

    func test_keystoreDerivedBAK_roundTripsThroughBootApproval() async throws {
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "test")
        let bak = try await Keystore.deriveBAK(serverId: "home", reason: "test")
        let claim = BootApproval(
            requestId: "req-7",
            serverFqdn: "home.harry.flagship.services",
            requestedAt: 1, approvedAt: 2
        )
        let signed = try claim.sign(with: bak)
        XCTAssertTrue(BootApproval.verify(
            envelopeBase64: signed.envelopeBase64,
            signatureHex: signed.signatureHex,
            publicKey: bak.publicKey
        ))
        Keystore.wipe()
    }
}
