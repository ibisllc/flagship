import XCTest
@testable import FlagshipCore

/// Pins the Swift port (OrgServers.swift) to packages/protocol/test-vectors/org-servers/vectors.json
/// (tools/org-servers-vectors.ts): canonical forms, server codes, the org recipe, the seat KEM seed,
/// opening key-ring copies and the audit log chain. Built on test-vectors/org-authority.
final class OrgServersVectorTests: XCTestCase {
    private var A: [String: Any] = [:]
    private var V: [String: Any] = [:]

    override func setUpWithError() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let base = dir.appendingPathComponent("packages/protocol/test-vectors")
            let a = base.appendingPathComponent("org-authority/vectors.json"), v = base.appendingPathComponent("org-servers/vectors.json")
            if FileManager.default.fileExists(atPath: v.path) {
                A = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: a)) as? [String: Any])
                V = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: v)) as? [String: Any])
                return
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("org-servers vectors not found above \(#filePath)")
    }

    private func resolve(_ v: Any?) -> Any? {
        if let a = v as? [Any] { return a.map { resolve($0) as Any } }
        guard let o = v as? [String: Any] else { return v }
        if let k = o["$key"] as? String { return ((A["keys"] as! [String: Any])[k] as! [String: Any])["binding"] }
        if let i = o["$approval"] as? NSNumber { return (A["approvals"] as! [Any])[i.intValue] }
        return o.mapValues { resolve($0) as Any }
    }
    private func i64(_ v: Any?) -> Int64 { (v as! NSNumber).int64Value }
    private func canonical(_ name: String) -> String {
        (V["canonical"] as! [[String: Any]]).first { $0["name"] as? String == name }!["bytes"] as! String
    }

    private func ctx(_ now: Int64) throws -> (OrgAuthorityState, OrgSeatBook) {
        let chain = resolve((A["chains"] as! [Any])[0]) as! [String: Any]
        let entries = try (chain["entries"] as! [Any]).prefix(2).map { try OrgAuthorityWire.entry($0) }
        let st = try OrgAuthority.verifyChain(Array(entries), genesisHash: A["genesisHash"] as! String, now: now, freezes: [], overturns: [], vetoes: [])
        let book = resolve((A["seatBooks"] as! [Any])[0]) as! [String: Any]
        let b = OrgAuthority.buildSeatBook(st, grants: try (book["grants"] as! [Any]).map { try OrgAuthorityWire.grantBundle($0) }, revokes: [], now: now)
        return (st, b)
    }

    func testCanonicalForms() throws {
        for c in V["canonical"] as! [[String: Any]] {
            XCTAssertEqual(OrgAuthority.sha256Hex(Array((c["bytes"] as! String).utf8)), c["sha256"] as? String, c["name"] as! String)
        }
        let code = try OrgServerCode.fromWire((V["serverCodes"] as! [[String: Any]])[0]["code"])
        XCTAssertEqual(String(decoding: try OrgAuthority.canonicalServerCode(code), as: UTF8.self), canonical("server code"))
        let r = (V["register"] as! [String: Any])["request"] as! [String: Any]
        XCTAssertEqual(String(decoding: try OrgAuthority.canonicalServerRegister(orgId: r["orgId"] as! String, serial: r["serial"] as! String,
            serverDomain: r["serverDomain"] as! String, codeSha256: r["codeSha256"] as! String, serverIdentityPubKeyHex: r["serverIdentityPubKeyHex"] as! String,
            issuedAt: i64(r["issuedAt"]), nonceHex: r["nonceHex"] as! String), as: UTF8.self), canonical("server register"))
        let kem = ((V["kems"] as! [String: Any])["seat"] as! [[String: Any]])[0]["statement"] as! [String: Any]
        XCTAssertEqual(String(decoding: try OrgAuthority.canonicalSeatKem(orgId: kem["orgId"] as! String, seatId: kem["seatId"] as! String,
            kemKeyId: kem["kemKeyId"] as! String, issuedAt: i64(kem["issuedAt"])), as: UTF8.self), canonical("seat kem"))
        let box = ((V["kems"] as! [String: Any])["box"] as! [[String: Any]])[0]["statement"] as! [String: Any]
        XCTAssertEqual(String(decoding: try OrgAuthority.canonicalBoxKem(orgId: box["orgId"] as! String, serverDomain: box["serverDomain"] as! String,
            kemKeyId: box["kemKeyId"] as! String, issuedAt: i64(box["issuedAt"])), as: UTF8.self), canonical("box kem"))
        let ring = try OrgKeyRing.fromWire(((V["opens"] as! [[String: Any]])[0]["ring"] as! [String: Any])["ring"])
        XCTAssertEqual(String(decoding: try OrgAuthority.canonicalKeyRing(ring), as: UTF8.self), canonical("key ring v2"))
        let blob = (V["installBlobs"] as! [[String: Any]])[0]["blob"] as! [String: Any]
        XCTAssertEqual(String(decoding: try installBlob(blob), as: UTF8.self), canonical("install blob"))
        let st = (V["audit"] as! [String: Any])["export"] as! [String: Any]
        let s = st["statement"] as! [String: Any]
        XCTAssertEqual(String(decoding: try OrgAuthority.canonicalAuditExport(orgId: s["orgId"] as! String, oarVersion: i64(s["oarVersion"]), oarHash: s["oarHash"] as! String,
            logSeq: i64(s["logSeq"]), logHeadHash: s["logHeadHash"] as! String, issuedAt: i64(s["issuedAt"])), as: UTF8.self), canonical("audit export"))
    }

    private func installBlob(_ b: [String: Any]) throws -> [UInt8] {
        try OrgAuthority.canonicalInstallBlob(orgId: b["orgId"] as! String, genesisHash: b["genesisHash"] as! String, orgName: b["orgName"] as! String,
            serverName: b["serverName"] as! String, serverDomain: b["serverDomain"] as! String, registrationUrl: b["registrationUrl"] as! String,
            installerGitRef: b["installerGitRef"] as! String, phoneDelegatedPubKey: b["phoneDelegatedPubKey"] as! String,
            code: try OrgServerCode.fromWire(b["code"]), bootUnlockMode: b["bootUnlockMode"] as! String, diskEncryption: b["diskEncryption"] as! String)
    }

    func testServerCodes() throws {
        for c in V["serverCodes"] as! [[String: Any]] {
            let now = i64(c["now"]), (st, book) = try ctx(now)
            let want = (c["expect"] as! [String: Any])["ok"] as! Bool ? "ok" : (c["expect"] as! [String: Any])["code"] as! String
            var got = "ok"
            do {
                _ = try OrgAuthority.verifyServerCode(state: st, book: book, code: try OrgServerCode.fromWire(c["code"]),
                                                      approvals: try (c["approvals"] as! [Any]).map { try OrgAuthority.approvalFromWire($0) }, now: now)
            } catch let e as OrgAuthorityError { got = e.code }
            XCTAssertEqual(got, want, c["name"] as! String)
        }
    }

    func testRecipeCanonicalRefusals() throws {
        let blobs = V["installBlobs"] as! [[String: Any]]
        XCTAssertThrowsError(try installBlob(blobs[3]["blob"] as! [String: Any]), "a recipe whose code names another server")
        XCTAssertNotEqual(try installBlob(blobs[1]["blob"] as! [String: Any]), try installBlob(blobs[0]["blob"] as! [String: Any]))
    }

    func testSeatKemSeedAndOpens() throws {
        let s = V["seatKemSeed"] as! [String: Any]
        let seed = try OrgAuthority.seatKemSeed(umk: PqBin.unhex(s["umkHex"] as! String)!, orgId: V["orgId"] as! String)
        XCTAssertEqual(PqBin.hex(seed), s["seedHex"] as? String)
        XCTAssertEqual(OrgAuthority.kemKeyIdHex(try PqHybrid.hybridSealKeygen(seed: seed).publicKey), s["kemKeyId"] as? String)
        for o in V["opens"] as! [[String: Any]] {
            let bundle = o["ring"] as! [String: Any]
            let ring = try OrgKeyRing.fromWire(bundle["ring"])
            let recipients = (bundle["recipients"] as! [[String: Any]]).map {
                OrgKeyRecipient(recipient: $0["recipient"] as! String, kemKeyId: $0["kemKeyId"] as! String, sealedHex: $0["sealedHex"] as! String)
            }
            XCTAssertEqual(try OrgAuthority.recipientsHash(recipients), ring.recipientsHash, o["name"] as! String)
            let secret = try PqHybrid.hybridSealKeygen(seed: PqBin.unhex(o["kemSeedHex"] as! String)!).secretKey
            if let err = o["error"] as? String {
                XCTAssertThrowsError(try OrgAuthority.openKeyRing(ring, recipients: recipients, recipient: o["recipient"] as! String, kemSecret: secret)) {
                    XCTAssertEqual(($0 as? OrgAuthorityError)?.code, err)
                }
            } else {
                let key = try OrgAuthority.openKeyRing(ring, recipients: recipients, recipient: o["recipient"] as! String, kemSecret: secret)
                XCTAssertEqual(PqBin.hex(key), o["keyHex"] as? String, o["name"] as! String)
            }
        }
    }

    func testAuditLogChain() throws {
        let x = (V["audit"] as! [String: Any])["export"] as! [String: Any]
        var prev = String(repeating: "0", count: 64)
        for e in x["log"] as! [[String: Any]] {
            XCTAssertEqual(e["prevHash"] as? String, prev)
            let h = OrgAuthority.logEntryHash(orgId: x["orgId"] as! String, seq: i64(e["seq"]), prevHash: prev, kind: e["kind"] as! String,
                                              refSha256: e["refSha256"] as! String, at: i64(e["at"]))
            XCTAssertEqual(h, e["entryHash"] as? String)
            prev = h
        }
        XCTAssertEqual(prev, (x["statement"] as! [String: Any])["logHeadHash"] as? String)
    }
}
