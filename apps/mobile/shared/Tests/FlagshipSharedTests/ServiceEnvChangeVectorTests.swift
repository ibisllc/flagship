import XCTest
import CryptoKit
@testable import FlagshipAPI
import FlagshipCore

/// Pins `ServiceEnvChange` to
/// `packages/protocol/test-vectors/service-env-change/vectors.json`: the
/// value hash, the canonical bytes, the pinned IRK signatures, and every
/// change a box refuses.
final class ServiceEnvChangeVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/service-env-change/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func change(_ d: [String: Any]) -> ServiceEnvChange {
        ServiceEnvChange(
            serverId: d["serverId"] as? String ?? "",
            serviceId: d["serviceId"] as? String ?? "",
            op: d["op"] as? String ?? "",
            name: d["name"] as? String ?? "",
            valueSha256: d["valueSha256"] as? String ?? "",
            issuedAt: (d["issuedAt"] as? NSNumber)?.int64Value ?? 0,
            nonce: d["nonce"] as? String ?? ""
        )
    }

    func testReproducesEveryCase() throws {
        let v = try vectors()
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: try XCTUnwrap(HexUtil.decode(v["pub"] as! String)))
        let cases = try XCTUnwrap(v["cases"] as? [[String: Any]])
        XCTAssertEqual(cases.count, 4)
        for c in cases {
            let ch = change(try XCTUnwrap(c["change"] as? [String: Any]))
            if let value = c["value"] as? String {
                XCTAssertEqual(ServiceEnvChange.valueSha256(value), ch.valueSha256)
            }
            let bytes = try ch.canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), c["canonical"] as? String)
            let sig = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(pub.isValidSignature(sig, for: bytes))
        }
    }

    func testRefusesEveryInvalidChange() throws {
        let invalid = try XCTUnwrap(try vectors()["invalid"] as? [[String: Any]])
        XCTAssertEqual(invalid.count, 12)
        for d in invalid {
            XCTAssertThrowsError(try change(d).canonicalBytes(), "\(d)")
        }
    }

    func testFreshChangesCarryTheirOwnNonce() throws {
        let a = ServiceEnvChange.make(serverId: "home.a.flagship.services", serviceId: "a--b", set: "API_KEY", value: "v")
        let b = ServiceEnvChange.make(serverId: "home.a.flagship.services", serviceId: "a--b", unset: "API_KEY")
        XCTAssertNotEqual(a.nonce, b.nonce)
        XCTAssertEqual(b.valueSha256, "")
        XCTAssertNoThrow(try a.canonicalBytes())
        XCTAssertNoThrow(try b.canonicalBytes())
        XCTAssertNotNil(ServiceEnvChange.nameError("my-key"))
        XCTAssertNotNil(ServiceEnvChange.nameError("FLAGSHIP_APP_ID"))
        XCTAssertNil(ServiceEnvChange.nameError("API_KEY"))
    }
}
