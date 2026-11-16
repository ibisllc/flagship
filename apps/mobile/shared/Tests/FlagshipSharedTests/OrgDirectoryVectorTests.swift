import XCTest
@testable import FlagshipCore

/// Pins the Swift port (OrgDirectory.swift) to packages/protocol/test-vectors/org-directory/vectors.json
/// (tools/org-directory-vectors.ts): bodies, entry keys, sealing with a fixed nonce, the write form,
/// refusals and the newest-entry rule.
final class OrgDirectoryVectorTests: XCTestCase {
    private var V: [String: Any] = [:]

    override func setUpWithError() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let v = dir.appendingPathComponent("packages/protocol/test-vectors/org-directory/vectors.json")
            if FileManager.default.fileExists(atPath: v.path) {
                V = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: v)) as? [String: Any])
                return
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("org-directory vectors not found above \(#filePath)")
    }

    private func bytes(_ h: Any?) -> [UInt8] { PqBin.unhex(h as! String)! }

    func testEntries() throws {
        let orgId = V["orgId"] as! String
        for c in V["entries"] as! [[String: Any]] {
            let name = c["name"] as! String
            let entry = try OrgDirectoryEntry.fromWire(c["entry"])
            let sealed = try OrgDirectorySealed.fromWire(c["sealed"])
            let key = bytes(c["directoryKeyHex"])
            let version = (c["keyVersion"] as! NSNumber).int64Value
            XCTAssertEqual(String(decoding: try OrgDirectory.canonicalBody(entry), as: UTF8.self), c["body"] as? String, name)
            XCTAssertEqual(PqBin.hex(try OrgDirectory.entryKey(directoryKey: key, orgId: orgId, entryId: c["entryId"] as! String, keyVersion: version)), c["entryKeyHex"] as? String, name)
            let mine = try OrgDirectory.seal(orgId: orgId, entryId: c["entryId"] as! String, keyVersion: version, directoryKey: key, entry: entry,
                                             issuedAt: sealed.issuedAt, nonce: Array(bytes(sealed.sealedHex).prefix(12)))
            XCTAssertEqual(mine, sealed, name)
            XCTAssertEqual(String(decoding: try OrgDirectory.canonicalWrite(sealed), as: UTF8.self), c["write"] as? String, name)
            XCTAssertEqual(try OrgDirectory.open(sealed, directoryKey: key), entry, name)
            XCTAssertEqual(try OrgDirectory.parseBody(Array((c["body"] as! String).utf8)), entry, name)
        }
    }

    func testRefusals() throws {
        for c in V["opens"] as! [[String: Any]] {
            XCTAssertThrowsError(try OrgDirectory.open(try OrgDirectorySealed.fromWire(c["sealed"]), directoryKey: bytes(c["directoryKeyHex"])), c["name"] as! String)
        }
        for c in V["badBodies"] as! [[String: Any]] {
            XCTAssertThrowsError(try OrgDirectory.parseBody(Array((c["body"] as! String).utf8)), c["name"] as! String)
        }
        let e = try OrgDirectoryEntry.fromWire(((V["entries"] as! [[String: Any]])[0])["entry"])
        var nonNfc = e; nonNfc.pseudonym = "e\u{0301}"
        XCTAssertThrowsError(try OrgDirectory.canonicalBody(nonNfc))
        var piped = e; piped.pseudonym = "a|b"; piped.groups = ["x|y"]
        XCTAssertEqual(String(decoding: try OrgDirectory.canonicalBody(piped), as: UTF8.self).split(separator: "|", omittingEmptySubsequences: false).count, 11)
    }

    func testNewest() throws {
        let n = V["newest"] as! [String: Any]
        let keys = Dictionary(uniqueKeysWithValues: (n["keys"] as! [String: String]).map { (Int64($0.key)!, PqBin.unhex($0.value)!) })
        let sealed = try (n["sealed"] as! [Any]).map { try OrgDirectorySealed.fromWire($0) }
        let expect = n["expect"] as! [String: String]
        for order in [sealed, sealed.reversed()] {
            let view = OrgDirectory.openAll(orgId: V["orgId"] as! String, order, keys: keys)
            XCTAssertEqual(view.bySeat[expect["seat"]!]?.entry.pseudonym, expect["pseudonym"])
        }
    }
}

extension OrgDirectoryVectorTests {
    func testConnectorsAndProposals() throws {
        let c = V["connectors"] as! [String: Any]
        let cb = c["connector"] as! [String: Any]
        let conn = try OrgConnector.fromWire(cb["connector"])
        XCTAssertEqual(String(decoding: try OrgConnectors.canonicalConnector(conn), as: UTF8.self), c["connectorBytes"] as? String)
        XCTAssertEqual(try OrgConnectors.connectorKeyId(PqBin.unhex(cb["connectorPubHex"] as! String)!), conn.connectorKeyId)
        XCTAssertEqual(try OrgConnectors.mappingSha256(c["mapping"] as! [String: Any]), conn.mappingSha256)
        let now = (c["now"] as! NSNumber).int64Value
        for p in c["proposals"] as! [[String: Any]] {
            let b = p["bundle"] as! [String: Any]
            let v = try OrgConnectors.verifyProposal(connector: cb, proposal: b, rolesHash: p["rolesHash"] as! String, now: now)
            XCTAssertEqual(String(decoding: try OrgConnectors.canonicalProposal(v), as: UTF8.self), p["bytes"] as? String)
            for a in c["admins"] as! [[String: Any]] {
                let kp = try PqHybrid.hybridSealKeygen(seed: PqBin.unhex(a["kemSeedHex"] as! String)!)
                XCTAssertEqual(String(decoding: try OrgConnectors.openProposal(b, recipient: a["recipient"] as! String, kemSecret: kp.secretKey), as: UTF8.self), p["payload"] as? String)
            }
            var moved = b, prop = b["proposal"] as! [String: Any]
            prop["subject"] = String(repeating: "ee", count: 16); moved["proposal"] = prop
            XCTAssertThrowsError(try OrgConnectors.verifyProposal(connector: cb, proposal: moved, rolesHash: p["rolesHash"] as! String, now: now))
        }
        let d = (c["decision"] as! [String: Any])
        let s = d["statement"] as! [String: Any]
        XCTAssertEqual(String(decoding: try OrgConnectors.canonicalDecision(orgId: s["orgId"] as! String, proposalId: s["proposalId"] as! String, decision: s["decision"] as! String,
                                                                            refSha256: s["refSha256"] as! String, issuedAt: (s["issuedAt"] as! NSNumber).int64Value), as: UTF8.self), d["bytes"] as? String)
    }
}

extension OrgDirectoryVectorTests {
    private func authority() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let a = dir.appendingPathComponent("packages/protocol/test-vectors/org-authority/vectors.json")
            if FileManager.default.fileExists(atPath: a.path) { return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: a)) as? [String: Any]) }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("org-authority vectors not found")
    }
    private func resolve(_ v: Any?, _ A: [String: Any]) -> Any? {
        if let a = v as? [Any] { return a.map { resolve($0, A) as Any } }
        guard let o = v as? [String: Any] else { return v }
        if let k = o["$key"] as? String { return ((A["keys"] as! [String: Any])[k] as! [String: Any])["binding"] }
        if let i = o["$approval"] as? NSNumber { return (A["approvals"] as! [Any])[i.intValue] }
        return o.mapValues { resolve($0, A) as Any }
    }
    private func stateAndBook(_ A: [String: Any], entries n: Int, now: Int64) throws -> (OrgAuthorityState, OrgSeatBook) {
        let chain = resolve((A["chains"] as! [Any])[0], A) as! [String: Any]
        let entries = try (chain["entries"] as! [Any]).prefix(n).map { try OrgAuthorityWire.entry($0) }
        let st = try OrgAuthority.verifyChain(Array(entries), genesisHash: A["genesisHash"] as! String, now: now, freezes: [], overturns: [], vetoes: [])
        let book = resolve((A["seatBooks"] as! [Any])[0], A) as! [String: Any]
        return (st, OrgAuthority.buildSeatBook(st, grants: try (book["grants"] as! [Any]).map { try OrgAuthorityWire.grantBundle($0) }, revokes: [], now: now))
    }

    func testConnectorStanding() throws {
        let A = try authority()
        for c in (V["standing"] as! [String: Any])["cases"] as! [[String: Any]] {
            let now = (c["now"] as! NSNumber).int64Value
            let (st, book) = try stateAndBook(A, entries: (c["entries"] as! NSNumber).intValue, now: now)
            let s = try OrgConnectors.standing(st, book, connector: c["bundle"] as! [String: Any], now: now)
            let e = c["expect"] as! [String: Any]
            XCTAssertEqual(s.state, e["state"] as? String, c["name"] as! String)
            XCTAssertEqual(s.leftAt, (e["leftAt"] as? NSNumber)?.int64Value, c["name"] as! String)
            if let sa = e["suspendAt"] as? NSNumber { XCTAssertEqual(s.suspendAt, sa.int64Value) }
        }
    }

    func testMemberSlices() throws {
        let A = try authority()
        let S = V["slices"] as! [String: Any]
        let now = (S["now"] as! NSNumber).int64Value
        let (st, book) = try stateAndBook(A, entries: 2, now: now)
        let servers = S["servers"] as! [String]
        let dir = Dictionary(uniqueKeysWithValues: try (S["directory"] as! [Any]).map { w -> (String, OrgDirectoryEntry) in let e = try OrgDirectoryEntry.fromWire(w); return (e.seatId, e) })
        let key = PqBin.unhex(S["directoryKeyHex"] as! String)!
        for c in S["seats"] as! [[String: Any]] {
            let seatId = c["seatId"] as! String
            let sh = OrgDirectory.shares(st, book, seatId: seatId, servers: servers, now: now)
            let want = c["shares"] as! [String: Any]
            XCTAssertEqual(sh.seats, want["seats"] as? [String]); XCTAssertEqual(sh.servers, want["servers"] as? [String])
            let content = OrgDirectory.sliceContent(st, book, seatId: seatId, bySeat: dir, servers: servers, now: now)
            let payload = try OrgDirectory.slicePayload(orgId: V["orgId"] as! String, seatId: seatId, entries: content.entries, servers: content.servers)
            XCTAssertEqual(String(decoding: payload, as: UTF8.self), c["payload"] as? String)
            XCTAssertEqual(OrgDirectory.sliceContentTag(directoryKey: key, payload: payload), c["contentTag"] as? String)
            let slice = try OrgDirectorySlice.fromWire(c["slice"])
            XCTAssertEqual(String(decoding: try OrgDirectory.canonicalSliceWrite(slice), as: UTF8.self), c["write"] as? String)
            let kp = try PqHybrid.hybridSealKeygen(seed: PqBin.unhex(c["kemSeedHex"] as! String)!)
            let opened = try OrgDirectory.openSlice(slice, kemSecret: kp.secretKey)
            XCTAssertEqual(opened.entries, content.entries); XCTAssertEqual(opened.servers, content.servers)
        }
    }

    func testSealedMapping() throws {
        let c = V["connectors"] as! [String: Any]
        let m = c["mappingSealed"] as! [String: Any]
        let id = ((c["connector"] as! [String: Any])["connector"] as! [String: Any])["connectorId"] as! String
        let key = PqBin.unhex(m["directoryKeyHex"] as! String)!
        let sealed = m["sealed"] as! [String: Any]
        let opened = try OrgConnectors.openMapping(orgId: V["orgId"] as! String, connectorId: id, directoryKey: key, sealed: sealed)
        XCTAssertEqual(try OrgConnectors.mappingSha256(opened), try OrgConnectors.mappingSha256(c["mapping"] as! [String: Any]))
        let mine = try OrgConnectors.sealMapping(orgId: V["orgId"] as! String, connectorId: id, directoryKey: key, keyVersion: 1, mapping: c["mapping"] as! [String: Any],
                                                 nonce: Array(PqBin.unhex(sealed["sealedHex"] as! String)!.prefix(12)))
        XCTAssertEqual(mine["sealedHex"] as? String, sealed["sealedHex"] as? String)
    }
}
