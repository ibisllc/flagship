import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the restore-into-server orders to `packages/protocol/test-vectors/server-restore-merge/vectors.json`.
final class ServerRestoreMergeVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/server-restore-merge/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func i64(_ v: Any?) -> Int64 { (v as! NSNumber).int64Value }

    private func line(_ d: [String: Any]) -> ServerRestoreMerge.PlanLine {
        ServerRestoreMerge.PlanLine(
            archivedServiceId: d["archivedServiceId"] as! String,
            action: d["action"] as! String,
            targetServiceId: d["targetServiceId"] as? String,
            sameApp: (d["sameApp"] as? Bool) ?? false,
            guardCode: d["guardCode"] as? String,
            guardSchema: d["guardSchema"] as? String,
            guardGen: (d["guardGen"] as? NSNumber)?.intValue
        )
    }

    func testCanonicalBytesAndPlanDigest() throws {
        let v = try vectors()
        let stage = v["stage"] as! [String: Any]
        let so = stage["order"] as! [String: Any]
        let sb = try ServerRestoreMerge.stageBytes(.init(serverDomain: so["serverDomain"] as! String, archiveId: so["archiveId"] as! String, bytes: i64(so["bytes"]), sha256: so["sha256"] as! String, source: so["source"] as! String, issuedAt: i64(so["issuedAt"])))
        XCTAssertEqual(String(decoding: sb, as: UTF8.self), stage["canonical"] as? String)

        let plan = v["plan"] as! [String: Any]
        let lines = (plan["lines"] as! [[String: Any]]).map(line)
        XCTAssertEqual(try ServerRestoreMerge.planSha256(lines), plan["planSha256"] as? String)
        XCTAssertEqual(try ServerRestoreMerge.planSha256(lines.reversed()), plan["planSha256"] as? String)

        let merge = v["merge"] as! [String: Any]
        let mo = merge["order"] as! [String: Any]
        let mb = try ServerRestoreMerge.mergeBytes(.init(serverDomain: mo["serverDomain"] as! String, restoreId: mo["restoreId"] as! String, archiveId: mo["archiveId"] as! String, sha256: mo["sha256"] as! String, planSha256: mo["planSha256"] as! String, issuedAt: i64(mo["issuedAt"]), expiresAt: i64(mo["expiresAt"])))
        XCTAssertEqual(String(decoding: mb, as: UTF8.self), merge["canonical"] as? String)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: Data(hexString: v["adminPubHex"] as! String))
        XCTAssertTrue(pub.isValidSignature(Data(hexString: merge["signatureHex"] as! String), for: mb))

        for u in v["undo"] as! [[String: Any]] {
            let o = u["order"] as! [String: Any]
            let b = try ServerRestoreMerge.undoBytes(.init(serverDomain: o["serverDomain"] as! String, restoreId: o["restoreId"] as! String, serviceId: o["serviceId"] as! String, action: o["action"] as! String, issuedAt: i64(o["issuedAt"])))
            XCTAssertEqual(String(decoding: b, as: UTF8.self), u["canonical"] as? String)
        }
    }

    func testRefusesTheLinesTheBoxRefuses() throws {
        let v = try vectors()
        for c in v["invalidLines"] as! [[String: Any]] {
            XCTAssertThrowsError(try ServerRestoreMerge.lineString(line(c["line"] as! [String: Any])), c["name"] as! String)
        }
    }
}

private extension Data {
    init(hexString: String) {
        var d = Data()
        var i = hexString.startIndex
        while i < hexString.endIndex {
            let j = hexString.index(i, offsetBy: 2)
            d.append(UInt8(hexString[i..<j], radix: 16)!)
            i = j
        }
        self = d
    }
}
