import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore

/// The Swift half of packages/protocol/test-vectors/keyfile/vectors.json: v1 and the v2 account
/// file (admin root and server records with their pinned keys) open to exactly what the TS writer
/// put in, every refusal matches, and a v2 file this port writes opens back.
final class KeyfileVectorTests: XCTestCase {
    private func load() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/keyfile/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("keyfile vectors not found above \(#filePath)")
    }

    private func hex(_ k: SymmetricKey) -> String { HexUtil.encode(k.withUnsafeBytes { Data($0) }) }

    func testOpenCases() throws {
        let v = try load()
        let pass = v["passphrase"] as! String
        for c in v["open"] as! [[String: Any]] {
            let name = c["name"] as! String
            let e = c["expect"] as! [String: Any]
            let a = try Keyfile.unwrapAccount(fileText: c["file"] as! String, passphrase: pass)
            XCTAssertEqual(hex(a.umkSeed), e["umkSeedHex"] as? String, name)
            XCTAssertEqual(a.adminRootSeed.map { HexUtil.encode($0) }, e["adminRootSeedHex"] as? String, name)
            XCTAssertEqual(a.meta.username, e["username"] as? String, name)
            XCTAssertEqual(a.meta.accountId, e["accountId"] as? String, name)
            XCTAssertEqual(a.version, (e["version"] as! NSNumber).intValue, name)
            let want = (e["servers"] as! [[String: Any]]).map {
                Keyfile.Server(domain: $0["domain"] as! String, lan: ($0["lan"] as? [String]) ?? [], stk: $0["stk"] as? String)
            }
            XCTAssertEqual(a.servers, want, name)
            // The UMK-only reader opens every version.
            XCTAssertEqual(hex(try Keyfile.unwrap(fileText: c["file"] as! String, passphrase: pass).umkSeed), e["umkSeedHex"] as? String, name)
        }
    }

    func testRefusals() throws {
        let v = try load()
        for c in v["refuse"] as! [[String: Any]] {
            let name = c["name"] as! String
            var got = "ok"
            do {
                _ = try Keyfile.unwrapAccount(fileText: c["file"] as! String, passphrase: (c["passphrase"] as? String) ?? (v["passphrase"] as! String))
            } catch let e as Keyfile.KeyfileError {
                switch e {
                case .badPassphrase: got = "bad-passphrase"
                case .version: got = "version"
                case .malformed: got = "malformed"
                }
            }
            XCTAssertEqual(got, c["error"] as? String, name)
        }
    }

    func testWriteV2OpensBack() throws {
        let umk = Data(repeating: 0x11, count: 32)
        let admin = Data(repeating: 0x22, count: 32)
        let servers = [Keyfile.Server(domain: "Home.Alice.flagship.services", lan: ["192.168.1.20:443"], stk: String(repeating: "ab", count: 32))]
        let text = try Keyfile.wrapAccount(umkSeed: umk, adminRootSeed: admin, servers: servers, passphrase: "a long passphrase",
                                           meta: .init(username: "alice", accountId: nil, createdAt: "2026-10-25T00:00:00Z"),
                                           params: .init(m: 256, t: 1, p: 1))
        XCTAssertFalse(text.contains(HexUtil.encode(admin)), "nothing in the clear")
        let a = try Keyfile.unwrapAccount(fileText: text, passphrase: "a long passphrase")
        XCTAssertEqual(a.version, 2)
        XCTAssertEqual(hex(a.umkSeed), HexUtil.encode(umk))
        XCTAssertEqual(a.adminRootSeed, admin)
        XCTAssertEqual(a.servers, [Keyfile.Server(domain: "home.alice.flagship.services", lan: ["192.168.1.20:443"], stk: String(repeating: "ab", count: 32))])
        XCTAssertThrowsError(try Keyfile.unwrapAccount(fileText: text, passphrase: "the wrong passphrase"))
    }
}
