import XCTest
@testable import FlagshipCore

/// The phone's CA lease PQ gate against packages/protocol/test-vectors/ca-lease-pq/vectors.json,
/// and its baked pin against caLeasePq.ts.
final class CaLeasePqVectorTests: XCTestCase {
    private func root() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("packages/protocol").path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("repo root not found")
    }

    private func lease(_ o: [String: Any]) -> CaEndorsement {
        CaEndorsement(kind: o["kind"] as! String, version: (o["version"] as! NSNumber).intValue, endorsementId: o["endorsementId"] as! String,
                      track: o["track"] as! String, caPubkey: o["caPubkey"] as! String, scope: o["scope"] as! String,
                      notBefore: o["notBefore"] as! String, notAfter: o["notAfter"] as! String, issuedAt: o["issuedAt"] as! String,
                      signedBy: o["signedBy"] as! String,
                      signatures: (o["signatures"] as! [[String: String]]).map { MaintainersSignature(pubkey: $0["pubkey"]!, sig: $0["sig"]!) })
    }

    func testEveryCase() throws {
        let url = try root().appendingPathComponent("packages/protocol/test-vectors/ca-lease-pq/vectors.json")
        let v = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let leases = (v["leases"] as! [[String: Any]]).map(lease)
        XCTAssertEqual(leases.map { CaLeasePq.v1Digest($0) }, v["v1Digests"] as! [String])
        let now = (v["now"] as! NSNumber).int64Value
        for c in v["cases"] as! [[String: Any]] {
            let p = c["pin"] as! [String: Any]
            let got = CaLeasePq.gate(leases, bindings: c["bindings"] as! [Any], endorsements: c["endorsements"] as! [Any],
                                     pin: .init(keyIds: p["keyIds"] as! [String], legacyLeases: p["legacyLeases"] as! [String]), now: now)
            XCTAssertEqual(got.map(\.endorsementId), c["accepted"] as! [String], c["name"] as! String)
        }
    }

    func testTheBakedPinMatchesTheProtocolPin() throws {
        let src = try String(contentsOf: try root().appendingPathComponent("packages/protocol/src/caLeasePq.ts"), encoding: .utf8)
        func ids(_ field: String) throws -> [String] {
            let block = try XCTUnwrap(src.range(of: "\(field): Object\\.freeze\\(\\[([^\\]]*)\\]\\)", options: .regularExpression).map { String(src[$0]) })
            return block.components(separatedBy: "\"").enumerated().filter { $0.offset % 2 == 1 }.map(\.element)
        }
        XCTAssertEqual(try ids("keyIds"), CaLeasePq.pin.keyIds)
        XCTAssertEqual(try ids("legacyLeases"), CaLeasePq.pin.legacyLeases)
    }
}
