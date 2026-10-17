import XCTest
import CryptoKit
import FlagshipCore

/// Pins the Swift side of adding a device to
/// `packages/protocol/test-vectors/device-pairing/vectors.json`: the admit and
/// grant canonical bytes and signatures, the scope order and member scopes, the
/// sealed bundle's keys, and the sentence a non-admin device shows.
final class DevicePairingVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/device-pairing/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func key(_ hex: String) throws -> Curve25519.Signing.PrivateKey {
        try Curve25519.Signing.PrivateKey(rawRepresentation: try XCTUnwrap(HexUtil.decode(hex)))
    }

    func test_adminOnlyLineAndScopesMatchTheVectors() throws {
        let v = try vectors()
        XCTAssertEqual(DeviceCapabilityGrantEnvelope.addDeviceAdminOnlyLine, v["adminOnlyLine"] as? String)
        XCTAssertEqual(DeviceCapabilityGrantEnvelope.deviceScopeOrder, v["scopeOrder"] as? [String])
        XCTAssertEqual(DeviceCapabilityGrantEnvelope.memberScopes, v["memberScopes"] as? [String])
    }

    func test_admitCanonicalAndSignature() throws {
        let v = try vectors()
        let keys = try XCTUnwrap(v["keys"] as? [String: String])
        let a = try XCTUnwrap(v["admit"] as? [String: Any])
        let f = try XCTUnwrap(a["fields"] as? [String: Any])
        let admit = DeviceAdmit(
            username: f["username"] as! String,
            deviceId: f["deviceId"] as! String,
            newDevicePubHex: f["newDevicePubHex"] as! String,
            issuedAt: (f["issuedAt"] as! NSNumber).int64Value
        )
        XCTAssertEqual(String(decoding: admit.canonicalBytes(), as: UTF8.self), a["canonical"] as? String)
        let irk = try key(keys["irkSeedHex"]!)
        XCTAssertEqual(HexUtil.encode(irk.publicKey.rawRepresentation), keys["irkPubHex"])
        // CryptoKit signs with hedged randomness, so check the pinned signature
        // verifies and ours does too instead of comparing bytes.
        let pinned = try XCTUnwrap(HexUtil.decode(a["signatureHex"] as! String))
        XCTAssertTrue(irk.publicKey.isValidSignature(pinned, for: admit.canonicalBytes()))
        XCTAssertTrue(irk.publicKey.isValidSignature(try admit.sign(with: irk), for: admit.canonicalBytes()))
    }

    func test_memberAndAdminGrantsSignAsPinned() throws {
        let v = try vectors()
        let keys = try XCTUnwrap(v["keys"] as? [String: String])
        for (name, seed) in [("memberGrant", "irkSeedHex"), ("adminGrant", "adminRootSeedHex")] {
            let g = try XCTUnwrap(v[name] as? [String: Any])
            let f = try XCTUnwrap(g["grant"] as? [String: Any])
            let env = DeviceCapabilityGrantEnvelope(
                grantId: f["grantId"] as! String,
                username: f["username"] as! String,
                deviceId: f["deviceId"] as! String,
                devicePubKeyHex: f["devicePubHex"] as! String,
                scopes: f["scopes"] as! [String],
                issuedAt: (f["issuedAt"] as! NSNumber).int64Value,
                expiresAt: (f["expiresAt"] as! NSNumber).int64Value
            )
            XCTAssertEqual(String(decoding: env.canonicalBytes(), as: UTF8.self), g["canonical"] as? String, name)
            let signer = try key(keys[seed]!)
            let pinned = try XCTUnwrap(HexUtil.decode(g["signatureHex"] as! String))
            XCTAssertTrue(signer.publicKey.isValidSignature(pinned, for: env.canonicalBytes()), name)
            let sig = try signer.signature(for: env.canonicalBytes())
            XCTAssertTrue(signer.publicKey.isValidSignature(sig, for: env.canonicalBytes()), name)
        }
        let member = try XCTUnwrap((v["memberGrant"] as? [String: Any])?["grant"] as? [String: Any])
        XCTAssertEqual(member["scopes"] as? [String], DeviceCapabilityGrantEnvelope.memberScopes)
        XCTAssertEqual(member["signerRoot"] as? String, "membership")
        let admin = try XCTUnwrap((v["adminGrant"] as? [String: Any])?["grant"] as? [String: Any])
        XCTAssertEqual(admin["scopes"] as? [String], DeviceCapabilityGrantEnvelope.deviceScopeOrder)
        XCTAssertEqual(admin["signerRoot"] as? String, "admin-root")
    }

    func test_bundleCarriesExactlyTheVectorKeys() throws {
        let v = try vectors()
        let bundle = PairingBundle(
            umkSeedHex: String(repeating: "a", count: 64),
            admit: .init(username: "harry", deviceId: "10", newDevicePubHex: "ab", issuedAt: 1),
            admitSig: "cd", irkPubHex: "ef",
            grant: .init(grantId: "g", username: "harry", deviceId: "10", devicePubHex: "ab",
                         scopes: DeviceCapabilityGrantEnvelope.memberScopes, issuedAt: 1, expiresAt: 2,
                         signerRoot: "membership"),
            grantSignature: "01", wrappedAdminRoot: "02"
        )
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: try bundle.encoded()) as? [String: Any])
        let want = Set((v["bundleKeys"] as! [String]).map { $0.hasSuffix("?") ? String($0.dropLast()) : $0 })
        XCTAssertEqual(Set(obj.keys), want)
    }
}
