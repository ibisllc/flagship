import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

/// Pins the Swift `server-unrevoke` canonical bytes and the cross-platform
/// golden vector. `.com` re-derives these bytes
/// (`canonicalServerUnrevocation` in `packages/protocol/src/installBlob.ts`) to
/// verify the signature; the TS half is
/// `packages/protocol/tests/serverUnrevocation.test.ts`.
final class ServerUnrevocationCanonicalTests: XCTestCase {
    private let seedHex = "ae7204fc0384c689bfb676523656b66d804cb51c262c7552b03e51bba8767ac3"
    private let pubHex = "c49775473bf9dcf5ad1608c8e66823d55dc6889be27e42a029fd9de195c8d7e4"
    private let sigHex = "669bfc297531e634d70af2ec4c846aa0eb249bf5c00ce5e6e065a63ce5c86c175f4b930894e45b68ef858f4d397c4442a0faf12ef8c35e2b3d2c949a6b3bbe03"

    private func vectorBytes() -> Data {
        ServerUnrevocation.canonicalBytes(
            username: "harry",
            serverDomain: "home.harry.flagship.services",
            issuedAt: 1_700_000_000_000
        )
    }

    func testCanonicalBytesMatchGoldenVector() {
        XCTAssertEqual(
            String(data: vectorBytes(), encoding: .utf8),
            "flagship/server-unrevoke/v1|harry|home.harry.flagship.services|1700000000000"
        )
        XCTAssertEqual(ServerUnrevocation.canonicalTag, "flagship/server-unrevoke/v1")
    }

    func testGoldenSeedDerivesGoldenPublicKey() throws {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: XCTUnwrap(HexUtil.decode(seedHex)))
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), pubHex)
    }

    func testGoldenSignatureVerifies() throws {
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: XCTUnwrap(HexUtil.decode(pubHex)))
        let sig = try XCTUnwrap(HexUtil.decode(sigHex))
        XCTAssertTrue(pub.isValidSignature(sig, for: vectorBytes()))
    }

    func testOwnSignatureVerifiesUnderGoldenKey() throws {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: XCTUnwrap(HexUtil.decode(seedHex)))
        let sig = try key.signature(for: vectorBytes())
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: vectorBytes()))
    }

    /// A signature over the revoke bytes must never pass as an un-revoke.
    func testRevocationSignatureDoesNotVerifyAsUnrevocation() throws {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: XCTUnwrap(HexUtil.decode(seedHex)))
        let revokeSig = try key.signature(for: ServerRevocationClaim.canonicalBytes(
            userId: "harry", revokedServerId: "home.harry.flagship.services",
            reason: "lost", issuedAt: 1_700_000_000_000
        ))
        XCTAssertFalse(key.publicKey.isValidSignature(revokeSig, for: vectorBytes()))
    }

    func testRequestWireShape() throws {
        let req = ServerUnrevocationRequest(
            request: .init(username: "harry", serverDomain: "home.harry.flagship.services", issuedAt: 1_700_000_000_000),
            signature: sigHex
        )
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any])
        XCTAssertEqual(obj["signature"] as? String, sigHex)
        let inner = try XCTUnwrap(obj["request"] as? [String: Any])
        XCTAssertEqual(inner["username"] as? String, "harry")
        XCTAssertEqual(inner["serverDomain"] as? String, "home.harry.flagship.services")
        XCTAssertEqual((inner["issuedAt"] as? NSNumber)?.int64Value, 1_700_000_000_000)
        XCTAssertEqual(inner.count, 3)
    }

    func testResponseDecodesBothShapes() throws {
        let restored = try JSONDecoder().decode(
            ServerUnrevocationResponse.self,
            from: Data(#"{"ok":true,"unrevokedAt":1700000000123,"dnsRepublished":4}"#.utf8)
        )
        XCTAssertEqual(restored.unrevokedAt, 1_700_000_000_123)
        XCTAssertEqual(restored.dnsRepublished, 4)
        XCTAssertNil(restored.alreadyActive)
        let noop = try JSONDecoder().decode(
            ServerUnrevocationResponse.self,
            from: Data(#"{"ok":true,"alreadyActive":true}"#.utf8)
        )
        XCTAssertEqual(noop.alreadyActive, true)
        XCTAssertNil(noop.unrevokedAt)
    }

    func testMockMirrorsWorker() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let domain = "home.harry.flagship.services"
        let req = ServerUnrevocationRequest(
            request: .init(username: "harry", serverDomain: domain, issuedAt: 1),
            signature: sigHex
        )
        let first = try await mock.unrevokeServer(req)
        XCTAssertEqual(first.alreadyActive, true, "un-revoking a live server is a noop")

        try await mock.revokeServer(.init(
            request: .init(userId: "harry", revokedServerId: domain, reason: "stolen", issuedAt: 1),
            signature: sigHex
        ))
        let restored = try await mock.unrevokeServer(req)
        XCTAssertNotNil(restored.unrevokedAt)
        XCTAssertNil(restored.alreadyActive)
        XCTAssertEqual(mock.unrevokedServers.count, 2)

        mock.nonRestorableRevokes = [domain]
        do {
            _ = try await mock.unrevokeServer(req)
            XCTFail("expected 409")
        } catch ScreensClientError.http(let status, _) {
            XCTAssertEqual(status, 409)
        }
    }
}
