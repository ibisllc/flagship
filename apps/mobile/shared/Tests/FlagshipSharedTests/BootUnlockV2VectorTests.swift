import XCTest
@testable import FlagshipCore

/// The phone side of boot unlock v2 against packages/protocol/test-vectors/boot-unlock-v2/vectors.json:
/// the material and request checks, and the reply and lease seals reproduced byte for byte (so
/// the box ports, which open the same bytes, open what this phone seals).
final class BootUnlockV2VectorTests: XCTestCase {
    private var v: [String: Any] = [:]

    override func setUpWithError() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("packages/protocol").path) { break }
            dir = dir.deletingLastPathComponent()
        }
        let url = dir.appendingPathComponent("packages/protocol/test-vectors/boot-unlock-v2/vectors.json")
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("vectors not found") }
        v = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func key(_ k: String, _ f: String) -> String { ((v["keys"] as! [String: Any])[k] as! [String: Any])[f] as! String }
    private var domain: String { v["serverDomain"] as! String }
    private var now: Int64 { (v["now"] as! NSNumber).int64Value }
    private func hex(_ s: String) -> [UInt8] { PqBin.unhex(s)! }
    private func stkBinding() throws -> VerifiedPqKeyBinding {
        try PqTrust.verifyPqKeyBinding(v["stkBinding"], PqBindingExpectation(role: "box-stk", subjectId: domain,
                                                                              ed25519PubHex: String(key("stk", "publicKey").prefix(64)), now: now))
    }
    private func ownerSign(_ k: String) -> BootUnlockV2.OwnerSigner {
        let sk = hex(key(k, "edSeed") + key(k, "mldsaSeed"))
        return { p, m in try PqHybrid.hybridSign(secretKey: sk, purpose: p, payload: m, deterministic: true) }
    }
    private func code(_ f: () throws -> Void) -> String {
        do { try f(); return "ok" } catch let e as BootUnlockV2.Failure { return e.code } catch { return "other: \(error)" }
    }

    func testMaterialCases() throws {
        let stk = try stkBinding()
        let m = v["material"] as! [String: Any]
        for c in m["cases"] as! [[String: Any]] {
            let got = code { _ = try BootUnlockV2.verifyMaterial(c["wire"], serverDomain: domain, bootPubHex: c["bootPubHex"] as! String, stkBinding: stk, now: now) }
            XCTAssertEqual(got, c["expect"] as? String, c["name"] as! String)
        }
    }

    func testRequestCases() throws {
        let material = try BootUnlockV2.verifyMaterial((v["material"] as! [String: Any])["wire"], serverDomain: domain,
                                                       bootPubHex: key("boot", "pubHex"), stkBinding: try stkBinding(), now: now)
        XCTAssertEqual(material.custody, "tpm")
        for c in (v["request"] as! [String: Any])["cases"] as! [[String: Any]] {
            let r = c["v1"] as! [String: Any]
            let got = code {
                _ = try BootUnlockV2.verifyRequest(serverDomain: r["serverDomain"] as! String, bootPubHex: r["bootPubHex"] as! String,
                                                   purpose: r["purpose"] as! String, nonceHex: r["nonceHex"] as! String,
                                                   issuedAt: (r["issuedAt"] as! NSNumber).int64Value, pq: c["pq"], material: material)
            }
            XCTAssertEqual(got, c["expect"] as? String, c["name"] as! String)
        }
    }

    func testReplyAndLeaseAreByteIdentical() throws {
        let reply = v["reply"] as! [String: Any], ctx = reply["ctx"] as! [String: String]
        let sealed = try BootUnlockV2.buildReply(serverDomain: ctx["serverDomain"]!, bootPubHex: ctx["bootPubHex"]!, nonceHex: ctx["nonceHex"]!,
                                                 replyKemPub: hex(ctx["replyKemPubHex"]!), diskKey: hex(v["diskKey"] as! String),
                                                 ownerHybridPublicKey: hex(key("owner", "publicKey")),
                                                 issuedAt: (reply["issuedAt"] as! NSNumber).int64Value, sign: ownerSign("owner"),
                                                 randomness: hex(reply["randomness"] as! String))
        // CryptoKit's Ed25519 is randomized, so the signature inside differs from the TS bytes: the
        // header and encapsulation must match exactly, and the plaintext must open and verify.
        try assertOpens(sealed, expected: reply["sealed"] as! String, seed: key("replyKem", "seed"), purpose: BootUnlockV2.tagBootReplyV2,
                        context: [PqBin.utf8(ctx["serverDomain"]!), hex(ctx["bootPubHex"]!), PqBin.utf8("unlock-key"), hex(ctx["nonceHex"]!)],
                        statement: [BootUnlockV2.tagBootReplyV2, ctx["serverDomain"]!, ctx["bootPubHex"]!, "unlock-key", ctx["nonceHex"]!,
                                    key("replyKem", "keyId"), BootUnlockV2.sha512Hex(hex(v["diskKey"] as! String)), "\((reply["issuedAt"] as! NSNumber).int64Value)"])
        let lease = v["lease"] as! [String: Any], f = lease["fields"] as! [String: Any]
        let sealedKey = try BootUnlockV2.sealLease(serverDomain: f["serverDomain"] as! String, bootPubHex: f["bootPubHex"] as! String,
                                                   leaseId: f["leaseId"] as! String, issuedAt: (f["issuedAt"] as! NSNumber).int64Value,
                                                   expiresAt: (f["expiresAt"] as! NSNumber).int64Value,
                                                   leaseKemPublicKey: hex(key("leaseKem", "publicKey")), diskKey: hex(v["diskKey"] as! String),
                                                   ownerHybridPublicKey: hex(key("owner", "publicKey")), sign: ownerSign("owner"),
                                                   randomness: hex(lease["randomness"] as! String))
        try assertOpens(sealedKey, expected: lease["sealedKey"] as! String, seed: key("leaseKem", "seed"), purpose: BootUnlockV2.tagAutoUnlockLeaseV3,
                        context: [PqBin.utf8(f["serverDomain"] as! String), hex(f["bootPubHex"] as! String), PqBin.utf8(f["leaseId"] as! String)],
                        statement: [BootUnlockV2.tagAutoUnlockLeaseV3, f["serverDomain"] as! String, f["bootPubHex"] as! String, key("leaseKem", "keyId"),
                                    f["leaseId"] as! String, BootUnlockV2.sha512Hex(hex(v["diskKey"] as! String)),
                                    "\((f["issuedAt"] as! NSNumber).int64Value)", "\((f["expiresAt"] as! NSNumber).int64Value)", "-1"])
    }

    private func assertOpens(_ sealed: [UInt8], expected: String, seed: String, purpose: String, context: [[UInt8]], statement: [String]) throws {
        let (header, headerBytes, _) = try PqHybrid.decodeEnvelope(sealed)
        let prefix = 2 * (headerBytes.count + PqHybrid.sealEncLen)
        XCTAssertEqual(String(PqBin.hex(sealed).prefix(prefix)), String(expected.prefix(prefix)), "header and encapsulation")
        let opened = try PqHybrid.hybridOpen(recipientSecretKey: hex(seed), expectedPurpose: purpose, context: context, sealed: sealed)
        XCTAssertEqual(opened.header, header)
        let p = opened.plaintext
        let n = Int(p[0]) << 8 | Int(p[1])
        XCTAssertEqual(PqBin.hex(Array(p[2..<(2 + n)])), v["diskKey"] as? String)
        try PqHybrid.hybridVerify(publicKey: hex(key("owner", "publicKey")), purpose: purpose,
                                  payload: PqBin.utf8(statement.joined(separator: "|")), signature: Array(p[(2 + n)...]))
    }

    func testTheDowngradeChoices() throws {
        for c in v["replyChoice"] as! [[String: Any]] {
            var got = ""
            do {
                got = String(try BootUnlockV2.chooseReplyVersion(strict: c["strict"] as! Bool, material: c["material"] as! Bool,
                                                                 requestHasPq: c["requestHasPq"] as! Bool, canSignHybrid: c["canSignHybrid"] as! Bool))
            } catch let e as BootUnlockV2.Failure { got = e.code }
            XCTAssertEqual(got, c["expect"] as? String)
        }
        for c in v["leaseChoice"] as! [[String: Any]] {
            var got = ""
            do {
                got = String(try BootUnlockV2.chooseLeaseVersion(strict: c["strict"] as! Bool, material: c["material"] as! Bool, canSignHybrid: c["canSignHybrid"] as! Bool))
            } catch let e as BootUnlockV2.Failure { got = e.code }
            XCTAssertEqual(got, c["expect"] as? String)
        }
    }
}
