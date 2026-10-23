import XCTest
@testable import FlagshipCore

final class EnrollmentTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/enrollment/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    private func unhex(_ h: String) -> Data {
        var d = Data(); var i = h.startIndex
        while i < h.endIndex { let n = h.index(i, offsetBy: 2); d.append(UInt8(h[i..<n], radix: 16)!); i = n }
        return d
    }

    func testProofsAndCodesMatchTheSharedVector() throws {
        let v = try vectors()
        let secret = unhex(v["secretHex"] as! String)
        let proofs = v["proofs"] as! [[String: Any]]
        for p in proofs {
            let s = p["statement"] as! [String: String]
            XCTAssertEqual(Enrollment.proofHex(secret: secret, serverDomain: s["serverDomain"]!, stkPubHex: s["stkPubHex"]!, authCodeSerial: s["authCodeSerial"]!), p["proofHex"] as? String)
        }
        let first = proofs[0]["proofHex"] as! String
        for c in v["invalid"] as! [[String: Any]] {
            let s = c["statement"] as! [String: String]
            XCTAssertFalse(Enrollment.verify(secret: secret, serverDomain: s["serverDomain"]!, stkPubHex: s["stkPubHex"]!, authCodeSerial: s["authCodeSerial"]!, proofHex: first), c["name"] as? String ?? "")
        }
        for c in v["codes"] as! [[String: String]] {
            XCTAssertEqual(Enrollment.serverCode(stkPubHex: c["stkPubHex"]!), c["code"])
        }
        XCTAssertEqual(Enrollment.newSecret().count, 32)
        let studioKey = unhex(v["studioConfirmKeyHex"] as! String)
        for s in v["seen"] as! [[String: String]] {
            XCTAssertEqual(Enrollment.serverSeenMacHex(studioConfirmKey: studioKey, serverDomain: s["serverDomain"]!, stkPubHex: s["stkPubHex"]!), s["macHex"])
            XCTAssertFalse(Enrollment.verifyServerSeen(studioConfirmKey: studioKey, serverDomain: s["serverDomain"]!, stkPubHex: String(repeating: "ef", count: 32), macHex: s["macHex"]!))
        }
    }
}
