import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins the read-token mint requests to
/// `packages/protocol/test-vectors/account-read-token/vectors.json`.
/// CryptoKit's Ed25519 signatures are randomized, so a pinned signature is
/// checked by verifying it, and our own by verifying it too.
final class AccountReadTokenVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/account-read-token/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func section(_ key: String) throws -> [String: Any] {
        try XCTUnwrap(try vectors()[key] as? [String: Any])
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(s as? String))) }

    func testDerivesTheKeys() throws {
        let k = try section("keys")
        let umk = try hex(k["umkSeedHex"])
        let device = try AccountMetadata.deriveAccountDeviceKey(
            umk: umk, accountId: k["accountId"] as! String, deviceId: k["deviceId"] as! String
        )
        XCTAssertEqual(HexUtil.encode(device.rawRepresentation), k["deviceSeedHex"] as? String)
        XCTAssertEqual(HexUtil.encode(device.publicKey.rawRepresentation), k["devicePubHex"] as? String)
        let irkSeed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: umk))
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: irkSeed)
        XCTAssertEqual(HexUtil.encode(irk.publicKey.rawRepresentation), k["irkPubHex"] as? String)
    }

    func testReproducesTheDeviceRequest() throws {
        let k = try section("keys")
        let v = try section("device")
        let f = try XCTUnwrap(v["fields"] as? [String: Any])
        let canonical = AccountMetadata.canonicalDirectoryRequest(
            accountId: f["accountId"] as! String,
            deviceId: f["deviceId"] as! String,
            signerPubHex: f["signerPubHex"] as! String,
            method: f["method"] as! String,
            path: f["path"] as! String,
            requestId: f["requestId"] as! String,
            issuedAt: (f["issuedAt"] as! NSNumber).int64Value
        )
        XCTAssertEqual(String(decoding: canonical, as: UTF8.self), v["canonical"] as? String)
        XCTAssertEqual(f["path"] as? String, "/api/accounts/\(k["accountId"] as! String)/read-token")
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: try hex(k["devicePubHex"]))
        XCTAssertTrue(pub.isValidSignature(try hex(v["signatureHex"]), for: canonical))
        let reject = try XCTUnwrap(v["reject"] as? [String: Any])
        XCTAssertFalse(pub.isValidSignature(try hex(reject["signatureHex"]), for: canonical))
        let device = try Curve25519.Signing.PrivateKey(rawRepresentation: try hex(k["deviceSeedHex"]))
        XCTAssertTrue(pub.isValidSignature(try device.signature(for: canonical), for: canonical))
    }

    func testReproducesTheIrkClaim() throws {
        let k = try section("keys")
        let v = try section("irk")
        let f = try XCTUnwrap(v["fields"] as? [String: Any])
        let claim = DeviceEndpointClaim(
            username: f["username"] as! String,
            endpointLabel: f["endpointLabel"] as! String,
            phoneIrkPub: try hex(f["phoneIrkPub"]),
            issuedAt: (f["issuedAt"] as! NSNumber).int64Value,
            expiresAt: (f["expiresAt"] as! NSNumber).int64Value,
            nonce: try hex(f["nonce"])
        )
        XCTAssertEqual(claim.endpointLabel, AccountReadTokenCredential.irkEndpointLabel)
        XCTAssertEqual(String(decoding: try claim.canonicalBytes(), as: UTF8.self), v["canonical"] as? String)
        let irkPub = try Curve25519.Signing.PublicKey(rawRepresentation: try hex(k["irkPubHex"]))
        XCTAssertTrue(DeviceEndpointClaim.verify(claim, signature: try hex(v["signatureHex"]), irkPub: irkPub))
        let reject = try XCTUnwrap(v["reject"] as? [String: Any])
        XCTAssertFalse(DeviceEndpointClaim.verify(claim, signature: try hex(reject["signatureHex"]), irkPub: irkPub))
        let irk = try Curve25519.Signing.PrivateKey(
            rawRepresentation: try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: try hex(k["umkSeedHex"])))
        )
        XCTAssertTrue(DeviceEndpointClaim.verify(claim, signature: try claim.sign(with: irk), irkPub: irkPub))
    }
}
