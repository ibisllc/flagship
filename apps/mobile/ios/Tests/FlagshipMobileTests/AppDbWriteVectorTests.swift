import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI
import FlagshipCore

/// The iOS database write order against THE reference,
/// `packages/protocol/test-vectors/app-db-write/vectors.json`, loaded from
/// disk (never transcribed) so a divergence surfaces here, not as a box
/// refusing what the phone signed.
final class AppDbWriteVectorTests: XCTestCase {

    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/app-db-write/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    func test_canonicalBytesHashAndPinnedSignatures() throws {
        let v = try vectors()
        let umk = try XCTUnwrap(HexUtil.decode(v["umkSeedHex"] as! String))
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: umk))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), v["pub"] as? String)
        let all = try XCTUnwrap(v["cases"] as? [[String: Any]])
        XCTAssertFalse(all.isEmpty)
        for c in all {
            let sql = try XCTUnwrap(c["sql"] as? String)
            XCTAssertEqual(AppDbWriteGrant.sqlSha256(sql), c["sqlSha256"] as? String)
            let grant = AppDbWriteGrant(
                serverDomain: c["serverDomain"] as! String, serviceId: c["serviceId"] as! String,
                store: c["store"] as! String, sql: sql, issuedAt: (c["issuedAt"] as! NSNumber).int64Value)
            XCTAssertEqual(grant.sqlSha256, c["sqlSha256"] as? String)
            XCTAssertEqual(String(data: grant.canonicalBytes(), encoding: .utf8), c["canonical"] as? String)
            let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: grant.canonicalBytes()))
            // CryptoKit's signatures are randomized: ours differs but verifies.
            let req = try AppDbOrder.signed(sql: sql, serviceId: grant.serviceId, store: grant.store,
                                            serverDomain: grant.serverDomain, key: key, issuedAt: grant.issuedAt)
            XCTAssertEqual(req.grant, grant)
            XCTAssertTrue(key.publicKey.isValidSignature(HexUtil.decode(req.signature!)!, for: grant.canonicalBytes()))
            // Every field is bound.
            let tampered = [
                AppDbWriteGrant(serverDomain: "other.harry.flagship.services", serviceId: grant.serviceId,
                                store: grant.store, sqlSha256: grant.sqlSha256, issuedAt: grant.issuedAt),
                AppDbWriteGrant(serverDomain: grant.serverDomain, serviceId: grant.serviceId + "x",
                                store: grant.store, sqlSha256: grant.sqlSha256, issuedAt: grant.issuedAt),
                AppDbWriteGrant(serverDomain: grant.serverDomain, serviceId: grant.serviceId,
                                store: grant.store + "2", sqlSha256: grant.sqlSha256, issuedAt: grant.issuedAt),
                AppDbWriteGrant(serverDomain: grant.serverDomain, serviceId: grant.serviceId, store: grant.store,
                                sql: sql + " ", issuedAt: grant.issuedAt),
                AppDbWriteGrant(serverDomain: grant.serverDomain, serviceId: grant.serviceId,
                                store: grant.store, sqlSha256: grant.sqlSha256, issuedAt: grant.issuedAt + 1),
            ]
            for t in tampered {
                XCTAssertFalse(key.publicKey.isValidSignature(pinned, for: t.canonicalBytes()),
                               String(data: t.canonicalBytes(), encoding: .utf8) ?? "")
            }
        }
    }

    func test_hashIsOfTheExactUtf8Text() {
        // No normalizing: a trailing newline or another spelling is another order.
        XCTAssertNotEqual(AppDbWriteGrant.sqlSha256("DELETE FROM t;"), AppDbWriteGrant.sqlSha256("DELETE FROM t;\n"))
        XCTAssertEqual(AppDbWriteGrant.sqlSha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(AppDbWriteGrant.sqlSha256("é").count, 64)
    }

    func test_requestBodyShape() throws {
        let read = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            AppDbQueryRequest(sql: "SELECT 1"))) as? [String: Any])
        XCTAssertEqual(read.keys.sorted(), ["sql"])
        let grant = AppDbWriteGrant(serverDomain: "home.a.flagship.services", serviceId: "a--b", store: "default",
                                    sql: "DELETE FROM t", issuedAt: 5)
        let write = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            AppDbQueryRequest(sql: "DELETE FROM t", grant: grant, signature: "ab"))) as? [String: Any])
        XCTAssertEqual(write.keys.sorted(), ["grant", "signature", "sql"])
        let g = try XCTUnwrap(write["grant"] as? [String: Any])
        XCTAssertEqual(g.keys.sorted(), ["issuedAt", "serverDomain", "serviceId", "sqlSha256", "store"])
        XCTAssertEqual(g["issuedAt"] as? Int, 5)
    }
}
