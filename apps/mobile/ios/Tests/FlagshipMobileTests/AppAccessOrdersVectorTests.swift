import XCTest
import CryptoKit
@testable import FlagshipAPI
import FlagshipCore

/// The admin-only access orders (`flagship/app-rank/v1`,
/// `flagship/service-access-mode/v2`, `flagship/service-allow-remove/v2`)
/// against THE reference, packages/protocol/test-vectors/app-access-orders/
/// vectors.json (loaded from disk, never transcribed).
final class AppAccessOrdersVectorTests: XCTestCase {

    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/app-access-orders/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func signer(_ v: [String: Any]) throws -> Curve25519.Signing.PrivateKey {
        let seed = try XCTUnwrap(HexUtil.decode(v["signerSeedHex"] as! String))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), v["signerPub"] as? String)
        return key
    }

    private func section(_ v: [String: Any], _ name: String) throws -> (cases: [[String: Any]], invalid: [[String: Any]]) {
        let s = try XCTUnwrap(v[name] as? [String: Any])
        let cases = try XCTUnwrap(s["cases"] as? [[String: Any]])
        let invalid = try XCTUnwrap(s["invalid"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        XCTAssertFalse(invalid.isEmpty)
        return (cases, invalid)
    }

    private func at(_ c: [String: Any]) -> Int64 { (c["issuedAt"] as! NSNumber).int64Value }

    private func check(_ bytes: Data, _ c: [String: Any], _ key: Curve25519.Signing.PrivateKey) throws {
        XCTAssertEqual(String(data: bytes, encoding: .utf8), c["canonical"] as? String)
        let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
        XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: bytes), c["canonical"] as? String ?? "")
        XCTAssertTrue(key.publicKey.isValidSignature(try key.signature(for: bytes), for: bytes))
    }

    func test_rank() throws {
        let v = try vectors()
        let key = try signer(v)
        let s = try section(v, "rank")
        for c in s.cases {
            let o = AppRankOrder(serviceRef: c["serviceRef"] as! String, target: c["target"] as! String,
                                 rank: c["rank"] as! String, issuedAt: at(c))
            try check(try o.canonicalBytes(), c, key)
        }
        for c in s.invalid {
            let o = AppRankOrder(serviceRef: c["serviceRef"] as! String, target: c["target"] as! String,
                                 rank: c["rank"] as! String, issuedAt: at(c))
            XCTAssertThrowsError(try o.canonicalBytes(), c["why"] as? String ?? "")
        }
    }

    func test_mode() throws {
        let v = try vectors()
        let key = try signer(v)
        let s = try section(v, "mode")
        for c in s.cases {
            let o = ServiceAccessModeOrder(serviceRef: c["serviceRef"] as! String, mode: c["mode"] as! String,
                                           issuedAt: at(c))
            try check(try o.canonicalBytes(), c, key)
            XCTAssertNil(o.request["serverId"], "a v2 order names no server")
        }
        for c in s.invalid {
            let o = ServiceAccessModeOrder(serviceRef: c["serviceRef"] as! String, mode: c["mode"] as! String,
                                           issuedAt: at(c))
            XCTAssertThrowsError(try o.canonicalBytes(), c["why"] as? String ?? "")
        }
    }

    func test_remove() throws {
        let v = try vectors()
        let key = try signer(v)
        let s = try section(v, "remove")
        for c in s.cases {
            let o = ServiceAllowRemoveOrder(serviceRef: c["serviceRef"] as! String, aid: c["aid"] as! String,
                                            issuedAt: at(c))
            try check(try o.canonicalBytes(), c, key)
            XCTAssertNil(o.request["serverId"])
        }
        for c in s.invalid {
            let o = ServiceAllowRemoveOrder(serviceRef: c["serviceRef"] as! String, aid: c["aid"] as! String,
                                            issuedAt: at(c))
            XCTAssertThrowsError(try o.canonicalBytes(), c["why"] as? String ?? "")
        }
    }

    func test_targetsAndRefusedRows() {
        let pub = String(repeating: "ab", count: 32)
        XCTAssertEqual(AppRankOrder.deviceTarget(pub.uppercased()), "device:\(pub)")
        XCTAssertEqual(AppRankOrder.shareTarget("0F1E2D3C4B5A69788796A5B4C3D2E1F0"), "share:0f1e2d3c4b5a69788796a5b4c3d2e1f0")
        XCTAssertEqual(AppRankValue(.master), .master)
        XCTAssertEqual(AppMemberRole(wire: "owner"), .master, "a legacy owner reads as master")
        XCTAssertNil(AppMemberRole(wire: "refused"))
        let refused = AppAccountMember.device(id: "d0", pub: pub, admin: false, rank: nil, set: true, refused: true)
        XCTAssertNil(refused.role)
        XCTAssertEqual(refused.rankTarget, "device:\(pub)")
        let share = AppAccountMember.coManager(shareId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", label: "Mum", rank: "manager")
        XCTAssertEqual(share.role, .manager)
        XCTAssertEqual(share.rankTarget, "share:0f1e2d3c4b5a69788796a5b4c3d2e1f0")
    }

    func test_membersResponseDecodesAccountMembersAndCreators() throws {
        let json = #"""
        {"serviceId":"harry--chess-club","mode":"open","roles":["member","manager","master"],"defaultRole":"member",
         "descriptions":{},
         "accountMembers":[
           {"kind":"device","deviceId":"d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0","devicePub":"\#(String(repeating: "ab", count: 32))","tier":"admin","rank":"master","set":false,"refused":false},
           {"kind":"device","deviceId":"1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a","devicePub":"\#(String(repeating: "cd", count: 32))","tier":"member","rank":null,"set":true,"refused":true},
           {"kind":"co-manager","shareId":"0f1e2d3c4b5a69788796a5b4c3d2e1f0","label":"Mum","rank":"manager","set":false,"refused":false}],
         "members":[],
         "invites":[{"inviteId":"i1","role":"member","set":false,"tier":"member","creatorPub":"\#(String(repeating: "cd", count: 32))","creatorDeviceId":"1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a"},
                    {"inviteId":"i2","role":"member","set":false,"tier":null,"creatorPub":null,"creatorDeviceId":null}]}
        """#
        let r = try JSONDecoder().decode(AppMembersResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.account.count, 3)
        XCTAssertEqual(r.account[0].role, .master)
        XCTAssertTrue(r.account[0].isAdminDevice)
        XCTAssertNil(r.account[1].role)
        XCTAssertTrue(r.account[1].refused)
        XCTAssertEqual(r.account[2].label, "Mum")
        XCTAssertEqual(r.me(devicePub: String(repeating: "CD", count: 32), deviceId: nil)?.deviceId,
                       "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a")
        XCTAssertEqual(r.me(devicePub: nil, deviceId: "D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0")?.tier, "admin")
        XCTAssertNil(r.me(devicePub: nil, deviceId: nil))
        XCTAssertEqual(r.invite("i1")?.creatorDeviceId, "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a")
        XCTAssertNil(r.invite("i2")?.creatorPub)
        let old = #"{"serviceId":"s","mode":"open","roles":["member"],"defaultRole":"member","members":[],"invites":[]}"#
        XCTAssertTrue(try JSONDecoder().decode(AppMembersResponse.self, from: Data(old.utf8)).account.isEmpty)
    }
}
