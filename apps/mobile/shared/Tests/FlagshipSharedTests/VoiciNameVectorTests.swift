import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins `VoiciNameOrder` and the name rules to
/// `packages/protocol/test-vectors/voici-name/vectors.json`. CryptoKit's
/// Ed25519 signatures are randomized, so the pinned signatures are checked by
/// verifying them, and our own by verifying them too.
final class VoiciNameVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/voici-name/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func order(_ f: [String: Any]) -> VoiciNameOrder {
        VoiciNameOrder(
            user: f["user"] as! String,
            serviceId: f["serviceId"] as! String,
            name: f["name"] as! String,
            op: VoiciNameOrder.Op(rawValue: f["op"] as! String)!,
            issuedAt: (f["issuedAt"] as! NSNumber).int64Value,
            nonce: f["nonce"] as! String
        )
    }

    private func publicKey(_ v: [String: Any]) throws -> Curve25519.Signing.PublicKey {
        let keys = try XCTUnwrap(v["keys"] as? [String: Any])
        let pub = try XCTUnwrap(HexUtil.decode(try XCTUnwrap(keys["pubHex"] as? String)))
        return try Curve25519.Signing.PublicKey(rawRepresentation: pub)
    }

    func testSetAndClearReproduceTheCanonicalStringAndVerifyThePinnedSignature() throws {
        let v = try vectors()
        let pub = try publicKey(v)
        for kind in ["set", "clear"] {
            let case_ = try XCTUnwrap(v[kind] as? [String: Any])
            let o = order(try XCTUnwrap(case_["fields"] as? [String: Any]))
            XCTAssertEqual(String(decoding: try o.canonicalBytes(), as: UTF8.self), case_["canonical"] as? String, kind)
            XCTAssertTrue(o.verify(signatureHex: case_["signatureHex"] as! String, publicKey: pub), kind)
        }
    }

    func testRejectsEveryTamperedOrder() throws {
        let v = try vectors()
        let pub = try publicKey(v)
        for r in try XCTUnwrap(v["reject"] as? [[String: Any]]) {
            let o = order(try XCTUnwrap(r["order"] as? [String: Any]))
            XCTAssertFalse(o.verify(signatureHex: r["signatureHex"] as! String, publicKey: pub), r["why"] as? String ?? "")
        }
    }

    func testOurOwnSignatureVerifies() throws {
        let key = Curve25519.Signing.PrivateKey()
        let o = VoiciNameOrder.make(
            user: "Plucky-Avocet", serviceId: "plucky-avocet--halloween-party", name: "HalloweenParty",
            op: .set, now: 1_760_000_000_000, nonce: Data(repeating: 0x0b, count: 32)
        )
        XCTAssertEqual(o.user, "plucky-avocet")
        XCTAssertEqual(o.name, "halloweenparty")
        XCTAssertTrue(o.verify(signatureHex: try o.sign(with: key), publicKey: key.publicKey))
        let clear = VoiciNameOrder.make(user: "a", serviceId: "b", name: "ignored", op: .clear)
        XCTAssertEqual(clear.name, "")
    }

    func testRefusesSeparatorsControlCharactersAndABadNonce() {
        let good = String(repeating: "0b", count: 32)
        XCTAssertThrowsError(try VoiciNameOrder(user: "a|b", serviceId: "s", name: "", op: .clear, issuedAt: 1, nonce: good).canonicalBytes())
        XCTAssertThrowsError(try VoiciNameOrder(user: "a", serviceId: "s", name: "x\u{7}y", op: .set, issuedAt: 1, nonce: good).canonicalBytes())
        XCTAssertThrowsError(try VoiciNameOrder(user: "a", serviceId: "s", name: "", op: .clear, issuedAt: 1, nonce: "zz").canonicalBytes())
    }

    func testTheNameRulesMatchTheSharedVectors() throws {
        for n in try XCTUnwrap(try vectors()["names"] as? [[String: Any]]) {
            let typed = n["typed"] as! String
            let expected: VoiciName.Problem?
            switch n["problem"] as? String {
            case "too-short": expected = .tooShort
            case "too-long": expected = .tooLong
            case "characters": expected = .characters
            default: expected = nil
            }
            XCTAssertEqual(VoiciName.problem(typed), expected, typed)
            if expected == nil {
                XCTAssertEqual(VoiciName.key(typed), n["key"] as? String, typed)
            }
        }
    }
}
