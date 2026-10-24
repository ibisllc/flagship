import XCTest
@testable import FlagshipCore

/// Pins the Swift `flagship/pq-session/v1` port to packages/protocol/test-vectors/pq-session/.
final class PqSessionVectorTests: XCTestCase {
    private func load() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/pq-session/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("pq-session vectors not found above \(#filePath)")
    }

    private func h(_ v: Any?) -> [UInt8] { PqBin.unhex((v as? String) ?? "") ?? [] }

    private struct Party {
        let name: String, role: String, subject: String
        let secret: [UInt8]
        let binding: VerifiedPqKeyBinding
        func sign(_ p: String, _ m: [UInt8]) throws -> [UInt8] { try PqHybrid.hybridSign(secretKey: secret, purpose: p, payload: m, deterministic: true) }
    }

    private func world() throws -> (v: [String: Any], now: Int64, parties: [String: Party]) {
        let v = try load()
        let now = (v["now"] as! NSNumber).int64Value
        var ps: [String: Party] = [:]
        for p in v["parties"] as! [[String: Any]] {
            let b = p["binding"] as! [String: Any]
            let vb = try PqTrust.verifyPqKeyBinding(b as Any?, PqBindingExpectation(role: p["role"] as! String, subjectId: p["subject"] as! String,
                                                                                ed25519PubHex: b["ed25519PubHex"] as! String, now: now))
            XCTAssertEqual(vb.keyIdHex, p["keyIdHex"] as? String)
            ps[p["name"] as! String] = Party(name: p["name"] as! String, role: p["role"] as! String, subject: p["subject"] as! String,
                                             secret: h(p["edSeedHex"]) + h(p["mldsaSeedHex"]), binding: vb)
        }
        return (v, now, ps)
    }

    private func code(_ f: () throws -> Void) -> String {
        do { try f(); return "ok" } catch let e as PqSessionError { return e.code } catch { return "other:\(error)" }
    }

    private func jsonEqual(_ a: [String: Any], _ b: Any?) -> Bool {
        (a as NSDictionary).isEqual(to: (b as? [String: Any]) ?? [:])
    }

    func testTranscriptsAndInvalidCases() throws {
        let (v, now, ps) = try world()
        let box = ps[v["responder"] as! String]!
        let trusted = (v["responderTrusts"] as! [String]).map { ps[$0]! }
        let lookup: (String, String, String) -> VerifiedPqKeyBinding? = { role, subject, kid in
            trusted.first { $0.role == role && $0.subject == subject && $0.binding.keyIdHex == kid }?.binding
        }
        let r = v["randomness"] as! [String: Any]
        func start(_ t: [String: Any]) throws -> PqSession.Initiator {
            let ini = ps[t["initiator"] as! String]!
            return try PqSession.Initiator(responder: box.binding, initiatorRole: ini.role, identity: ini.binding, now: now,
                                           ephemeralSeed: h(r["ephemeralSeedHex"]), nonce: h(r["helloNonceHex"]))
        }
        func accept(_ hello: Any?) throws -> (accept: [String: Any], pending: PqSession.Pending) {
            try PqSession.accept(hello: hello, identity: box.binding, lookup: lookup, now: now + 100, sign: box.sign,
                                 encapsulation: h(r["encapsulationHex"]), nonce: h(r["acceptNonceHex"]))
        }

        // CryptoKit's Ed25519 signatures are randomized, so the signers hand back the vector's own
        // signature after checking it verifies over exactly the bytes this port built.
        func replay(_ b: VerifiedPqKeyBinding, _ sigHex: Any?) -> PqSession.Signer {
            { purpose, payload in
                let sig = self.h(sigHex)
                try PqHybrid.hybridVerify(publicKey: b.hybridPublicKey, purpose: purpose, payload: payload, signature: sig)
                return sig
            }
        }
        for t in v["transcripts"] as! [[String: Any]] {
            let ini = ps[t["initiator"] as! String]!
            let st = try start(t)
            XCTAssertTrue(jsonEqual(st.hello.jsonObject, t["hello"]))
            XCTAssertEqual(PqBin.hex(try st.hello.bytes()), t["helloBytesHex"] as? String)
            let va = t["accept"] as! [String: Any], vf = t["finish"] as! [String: Any]
            let (a, pending) = try PqSession.accept(hello: t["hello"], identity: box.binding, lookup: lookup, now: now + 100, sign: replay(box.binding, va["signature"]),
                                                    encapsulation: h(r["encapsulationHex"]), nonce: h(r["acceptNonceHex"]))
            XCTAssertTrue(jsonEqual(a, va), "accept \(t["name"]!)")
            // A real CryptoKit signature also completes a handshake with itself.
            let (own, ownPending) = try accept(t["hello"])
            let (ownF, ownI) = try start(t).finish(accept: own, now: now + 200, sign: ini.sign)
            XCTAssertEqual(try ownPending.complete(finish: ownF, now: now + 300).sessionIdHex, ownI.sessionIdHex)

            let (f, ichan) = try st.finish(accept: va, now: now + 200, sign: replay(ini.binding, vf["signature"]))
            XCTAssertTrue(jsonEqual(f, vf))
            let rchan = try pending.complete(finish: vf, now: now + 300)
            let k = t["keys"] as! [String: Any]
            XCTAssertEqual(ichan.sessionIdHex, k["sessionIdHex"] as? String)
            XCTAssertEqual(rchan.sessionIdHex, k["sessionIdHex"] as? String)
            let recs = t["records"] as! [[String: Any]]
            for rec in recs {
                let dir = UInt8((rec["dir"] as! NSNumber).intValue)
                let key = h(k[dir == 1 ? "initiatorToResponderHex" : "responderToInitiatorHex"])
                let seq = (rec["seq"] as! NSNumber).uint64Value
                XCTAssertEqual(PqBin.hex(try PqSession.sealRecord(key: key, sessionId: h(k["sessionIdHex"]), dir: dir, seq: seq, plaintext: h(rec["plaintextHex"]))),
                               rec["recordHex"] as? String)
            }
            XCTAssertEqual(PqBin.hex(try rchan.openRequest(h(recs[1]["recordHex"]), now: now + 400).plaintext), recs[1]["plaintextHex"] as? String)
            XCTAssertEqual(PqBin.hex(try rchan.openRequest(h(recs[0]["recordHex"]), now: now + 400).plaintext), recs[0]["plaintextHex"] as? String)
            XCTAssertEqual(PqBin.hex(try ichan.openResponse(seq: 1, record: h(recs[2]["recordHex"]))), recs[2]["plaintextHex"] as? String)
        }

        let t0 = (v["transcripts"] as! [[String: Any]])[0]
        let phone = ps["phone"]!
        let inv = v["invalid"] as! [String: Any]
        for c in inv["hello"] as! [[String: Any]] {
            XCTAssertEqual(code { _ = try accept(c["hello"]) }, c["expect"] as? String, "hello \(c["name"]!)")
        }
        for c in inv["accept"] as! [[String: Any]] {
            XCTAssertEqual(code { _ = try start(t0).finish(accept: c["accept"], now: now + 200, sign: phone.sign) }, c["expect"] as? String, "accept \(c["name"]!)")
        }
        let va0 = t0["accept"] as! [String: Any]
        func vectorPending() throws -> PqSession.Pending {
            try PqSession.accept(hello: t0["hello"], identity: box.binding, lookup: lookup, now: now + 100, sign: replay(box.binding, va0["signature"]),
                                 encapsulation: h(r["encapsulationHex"]), nonce: h(r["acceptNonceHex"])).pending
        }
        for c in inv["finish"] as! [[String: Any]] {
            let pending = try vectorPending()
            XCTAssertEqual(code { _ = try pending.complete(finish: c["finish"], now: now + 300) }, c["expect"] as? String, "finish \(c["name"]!)")
        }
        for c in inv["records"] as! [[String: Any]] {
            let pending = try vectorPending()
            let (_, ichan) = try start(t0).finish(accept: t0["accept"], now: now + 200, sign: replay(phone.binding, (t0["finish"] as! [String: Any])["signature"]))
            let rchan = try pending.complete(finish: t0["finish"], now: now + 300)
            let got: String
            if c["side"] as? String == "responder" {
                got = code { for rec in c["sequence"] as! [String] { _ = try rchan.openRequest(h(rec), now: now + 400) } }
            } else {
                got = code { _ = try ichan.openResponse(seq: (c["expectSeq"] as! NSNumber).uint64Value, record: h(c["record"])) }
            }
            XCTAssertEqual(got, c["expect"] as? String, "record \(c["name"]!)")
        }
    }
}
