import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins `ArchiveDownloadApproval` to packages/protocol/test-vectors/archive-download/vectors.json.
final class ArchiveDownloadApprovalTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/archive-download/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    func testCanonicalBytesCodeAndSignatureMatchTheVectors() throws {
        let v = try vectors()
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: try XCTUnwrap(HexUtil.decode(v["umkSeedHex"] as! String))))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), v["pub"] as? String)
        for c in try XCTUnwrap(v["cases"] as? [[String: Any]]) {
            let a = ArchiveDownloadApproval(serverDomain: c["serverDomain"] as! String, archiveId: c["archiveId"] as! String,
                                            requestId: c["requestId"] as! String, issuedAt: (c["issuedAt"] as! NSNumber).int64Value)
            XCTAssertEqual(String(data: a.canonicalBytes(), encoding: .utf8), c["canonical"] as? String)
            XCTAssertEqual(ArchiveDownloadApproval.code(requestId: a.requestId), c["code"] as? String)
            let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: a.canonicalBytes()))
            XCTAssertTrue(key.publicKey.isValidSignature(try key.signature(for: a.canonicalBytes()), for: a.canonicalBytes()))
        }
    }

    func testTheDownloadPageQrOpensTheApproval() {
        let url = URL(string: "https://flagshipserver.com/app/backup-download#s=home.harry.flagship.services&a=00112233445566778899aabbccddeeff&r=0f1e2d3c4b5a69788796a5b4c3d2e1f0")!
        XCTAssertEqual(DeepLink.parse(url), .approveBackupDownload(serverFqdn: "home.harry.flagship.services",
                                                                 archiveId: "00112233445566778899aabbccddeeff",
                                                                 requestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0"))
        // Not a Flagship server, or malformed ids: nothing.
        XCTAssertNil(DeepLink.parse(URL(string: "https://flagshipserver.com/app/backup-download#s=evil.example.com&a=00112233445566778899aabbccddeeff&r=0f1e2d3c4b5a69788796a5b4c3d2e1f0")!))
        XCTAssertNil(DeepLink.parse(URL(string: "https://flagshipserver.com/app/backup-download#s=home.harry.flagship.services&a=zz&r=0f1e2d3c4b5a69788796a5b4c3d2e1f0")!))
    }
}
