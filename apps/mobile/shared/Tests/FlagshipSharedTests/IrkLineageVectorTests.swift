import XCTest
import CryptoKit
@testable import FlagshipCore

/// packages/protocol/test-vectors/irk-lineage (tools/irk-lineage-vectors.mjs): every client's IRK
/// derivation, the registered key found from the UMK, and the key this app rotates to on a
/// key-file import.
final class IrkLineageVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/irk-lineage/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    private func umk(_ v: [String: Any]) -> SymmetricKey {
        SymmetricKey(data: HexUtil.decode(v["umkSeedHex"] as! String)!)
    }

    func test_everySchemeMatchesTheVectors() throws {
        let v = try vectors()
        for k in v["keys"] as! [[String: Any]] {
            let scheme = IrkLineage.Scheme(rawValue: k["scheme"] as! String)!
            let version = (k["version"] as! NSNumber).intValue
            let seed = IrkLineage.seed(umk: umk(v), scheme: scheme, version: version).withUnsafeBytes { Data($0) }
            XCTAssertEqual(HexUtil.encode(seed), k["seedHex"] as? String)
            XCTAssertEqual(try IrkLineage.key(umk: umk(v), scheme: scheme, version: version).pubHex, k["pubHex"] as? String)
        }
    }

    func test_findsTheRegisteredKeyAndRotatesPastIt() throws {
        let v = try vectors()
        for c in v["imports"] as! [[String: Any]] {
            let name = c["name"] as! String
            let reg = c["registered"] as! [String: Any]
            let found = try XCTUnwrap(IrkLineage.findRegistered(umk: umk(v), registeredPubHex: c["registeredPubHex"] as! String), name)
            XCTAssertEqual(found.scheme.rawValue, reg["scheme"] as? String, name)
            XCTAssertEqual(found.version, (reg["version"] as! NSNumber).intValue, name)
            let next = (c["importer"] as! [String: Any])["ios"] as! [String: Any]
            let newVersion = IrkLineage.nextVersion(after: found)
            XCTAssertEqual(newVersion, (next["newVersion"] as! NSNumber).intValue, name)
            XCTAssertEqual(try IrkLineage.key(umk: umk(v), scheme: IrkLineage.own, version: newVersion).pubHex, next["newPubHex"] as? String, name)
        }
        for c in v["noMatch"] as! [[String: Any]] {
            XCTAssertNil(IrkLineage.findRegistered(umk: umk(v), registeredPubHex: c["registeredPubHex"] as! String))
        }
    }
}
