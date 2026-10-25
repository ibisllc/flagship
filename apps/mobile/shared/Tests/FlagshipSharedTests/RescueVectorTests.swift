import XCTest
import CryptoKit
@testable import FlagshipCore

/// The Swift half of packages/protocol/test-vectors/rescue/ (vectors.json, offline-control.json and
/// pq-vectors.json): the hello and session bytes, the phone's hello check, the discovery id, the
/// offline-control orders and the post-quantum gate over all three.
final class RescueVectorTests: XCTestCase {
    private func load(_ name: String) throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/rescue/\(name)")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("test-vectors/rescue/\(name) not found above \(#filePath)")
    }

    private func d(_ v: Any?) -> Data { HexUtil.decode((v as? String) ?? "") ?? Data() }
    private func i64(_ v: Any?) -> Int64 { (v as? NSNumber)?.int64Value ?? -1 }

    private func exchange(_ c: [String: Any]) -> Rescue.Exchange {
        Rescue.Exchange(serverDomain: c["serverDomain"] as! String, clientNonce: c["clientNonce"] as! String,
                        boxNonce: c["boxNonce"] as! String, certSha256: c["certSha256"] as! String, issuedAt: i64(c["issuedAt"]))
    }

    func testHelloSessionAndDiscovery() throws {
        let v = try load("vectors.json")
        let irk = try Curve25519.Signing.PublicKey(rawRepresentation: d(v["irkPub"]))
        for c in v["cases"] as! [[String: Any]] {
            let x = exchange(c)
            let hello = try x.helloCanonical()
            let session = try x.sessionCanonical()
            XCTAssertEqual(String(decoding: hello, as: UTF8.self), c["helloCanonical"] as? String)
            XCTAssertEqual(String(decoding: session, as: UTF8.self), c["sessionCanonical"] as? String)
            let stk = try Curve25519.Signing.PublicKey(rawRepresentation: d(c["stkPub"]))
            XCTAssertTrue(stk.isValidSignature(d(c["helloSignature"]), for: hello))
            XCTAssertTrue(irk.isValidSignature(d(c["sessionSignature"]), for: session))
            // Distinct tags: a hello's signature never stands for a session order.
            XCTAssertFalse(stk.isValidSignature(d(c["helloSignature"]), for: session))
            XCTAssertEqual(Rescue.discoveryId(stkPub: d(c["stkPub"]), serverDomain: c["serverDomain"] as! String), c["discoveryId"] as? String)
            XCTAssertEqual(Rescue.discoveryId(stkPub: d(c["stkPub"]), serverDomain: (c["serverDomain"] as! String).uppercased()), c["discoveryId"] as? String)
            // The phone's own checks.
            let seen = c["certSha256"] as! String
            let now = i64(c["issuedAt"]) + 1000
            XCTAssertNil(Rescue.checkHello(x, signature: d(c["helloSignature"]), stkPub: d(c["stkPub"]), serverDomain: x.serverDomain,
                                           clientNonce: x.clientNonce, seenCertSha256: seen, now: now))
            XCTAssertEqual(Rescue.checkHello(x, signature: d(c["helloSignature"]), stkPub: d(c["stkPub"]), serverDomain: x.serverDomain,
                                             clientNonce: x.clientNonce, seenCertSha256: String(repeating: "cd", count: 32), now: now), "cert-mismatch")
            XCTAssertEqual(Rescue.checkHello(x, signature: d(c["helloSignature"]), stkPub: d(v["irkPub"]), serverDomain: x.serverDomain,
                                             clientNonce: x.clientNonce, seenCertSha256: seen, now: now), "bad-signature")
            XCTAssertEqual(Rescue.checkHello(x, signature: d(c["helloSignature"]), stkPub: d(c["stkPub"]), serverDomain: "x.other.flagship.services",
                                             clientNonce: x.clientNonce, seenCertSha256: seen, now: now), "wrong-server")
            XCTAssertEqual(Rescue.checkHello(x, signature: d(c["helloSignature"]), stkPub: d(c["stkPub"]), serverDomain: x.serverDomain,
                                             clientNonce: String(repeating: "9", count: 32), seenCertSha256: seen, now: now), "wrong-nonce")
            XCTAssertEqual(Rescue.checkHello(x, signature: d(c["helloSignature"]), stkPub: d(c["stkPub"]), serverDomain: x.serverDomain,
                                             clientNonce: x.clientNonce, seenCertSha256: seen, now: now + Rescue.helloTtlMs), "expired")
            XCTAssertEqual(Rescue.checkHello(x, signature: d(c["helloSignature"]), stkPub: d(c["stkPub"]), serverDomain: x.serverDomain,
                                             clientNonce: x.clientNonce, seenCertSha256: seen, now: now - 10 * 60_000), "not-yet-valid")
        }
        for c in v["invalid"] as! [[String: Any]] {
            XCTAssertThrowsError(try exchange(c).sessionCanonical())
        }
    }

    func testOfflineControlOrders() throws {
        let v = try load("offline-control.json")
        let irk = try Curve25519.Signing.PublicKey(rawRepresentation: d(v["irkPub"]))
        for c in v["cases"] as! [[String: Any]] {
            let o = c["order"] as! [String: Any]
            let order = OfflineControlOrder(serverDomain: o["serverDomain"] as! String, sessionNonce: o["sessionNonce"] as! String,
                                            actionName: o["action"] as! String, target: o["target"] as! String,
                                            nonce: o["nonce"] as! String, issuedAt: i64(o["issuedAt"]))
            let bytes = try order.canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), c["canonical"] as? String, c["name"] as! String)
            XCTAssertTrue(irk.isValidSignature(d(c["signature"]), for: bytes), c["name"] as! String)
            var moved = order
            moved.issuedAt += 1
            XCTAssertFalse(irk.isValidSignature(d(c["signature"]), for: try moved.canonicalBytes()))
        }
        for c in v["refused"] as! [[String: Any]] {
            let o = c["order"] as! [String: Any]
            let order = OfflineControlOrder(serverDomain: o["serverDomain"] as! String, sessionNonce: o["sessionNonce"] as! String,
                                            actionName: o["action"] as! String, target: o["target"] as! String,
                                            nonce: o["nonce"] as! String, issuedAt: i64(o["issuedAt"]))
            XCTAssertThrowsError(try order.canonicalBytes(), c["name"] as! String)
        }
    }

    private func policy(_ p: [String: Any]) -> PolicyState {
        PolicyState(scope: PolicyScope(kind: .installation, id: "x"), profile: AssuranceProfile(rawValue: p["profile"] as! String)!,
                    rollout: RolloutState(rawValue: p["rollout"] as! String)!, generation: 1,
                    headDigest: String(repeating: "0", count: 64), enforcedEver: false)
    }

    func testPqGate() throws {
        let v = try load("pq-vectors.json")
        let valid = (v["bindings"] as! [String: Any])["valid"] as! [[String: Any]]
        var bound: [String: VerifiedPqKeyBinding] = [:]
        for b in valid {
            let e = b["expect"] as! [String: Any]
            bound[b["name"] as! String] = try PqTrust.verifyPqKeyBinding(b["wire"], PqBindingExpectation(
                role: e["role"] as! String, subjectId: e["subjectId"] as! String, ed25519PubHex: e["ed25519PubHex"] as! String, now: i64(e["now"])))
        }
        // The bytes the cases sign are the ones this port builds.
        let x = exchange(v["exchange"] as! [String: Any])
        let gate = v["gate"] as! [[String: Any]]
        let msg = { (name: String) in gate.first { $0["name"] as? String == name }!["messageHex"] as! String }
        XCTAssertEqual(HexUtil.encode(try x.sessionCanonical()), msg("session-strict-hybrid"))
        XCTAssertEqual(HexUtil.encode(try x.helloCanonical()), msg("hello-strict-hybrid"))
        let o = v["controlOrder"] as! [String: Any]
        let order = OfflineControlOrder(serverDomain: o["serverDomain"] as! String, sessionNonce: o["sessionNonce"] as! String,
                                        actionName: o["action"] as! String, target: o["target"] as! String,
                                        nonce: o["nonce"] as! String, issuedAt: i64(o["issuedAt"]))
        XCTAssertEqual(HexUtil.encode(try order.canonicalBytes()), msg("control-strict-hybrid"))

        XCTAssertEqual(gate.count, 19)
        for c in gate {
            let name = c["name"] as! String
            let env = c["envelope"] as! [String: Any]
            let expect = c["expect"] as! [String: Any]
            var got = "ok"
            var verdict: CriticalSignatureVerdict?
            do {
                verdict = try PqTrust.verifyCriticalSignature(
                    message: [UInt8](d(c["messageHex"])), expectedPurpose: c["expectedPurpose"] as! String,
                    envelope: SignatureEnvelope(suite: env["suite"] as! String, signature: env["signature"] as! String),
                    signerEd25519PubHex: c["signerEd25519PubHex"] as! String, binding: (c["binding"] as? String).flatMap { bound[$0] },
                    policy: policy(c["policy"] as! [String: Any]))
            } catch let e as PqTrustError { got = e.code } catch let e as PqHybridError { got = e.code }
            if expect["ok"] as? Bool == true {
                XCTAssertEqual(got, "ok", name)
                XCTAssertEqual(verdict?.strict, expect["strict"] as? Bool, name)
            } else {
                XCTAssertEqual(got, expect["code"] as? String, name)
            }
        }

        // The phone's hello check under the pinned STK and ML-DSA key.
        let box = (v["signers"] as! [[String: Any]]).first { $0["name"] as? String == "box-stk" }!
        let stkHex = box["ed25519PubHex"] as! String
        let mldsa = box["mldsaPubHex"] as! String
        let hybrid = (gate.first { $0["name"] as? String == "hello-strict-hybrid" }!["envelope"] as! [String: Any])
        let env = SignatureEnvelope(suite: hybrid["suite"] as! String, signature: hybrid["signature"] as! String)
        XCTAssertNil(Rescue.checkHelloPq(x, pqSignature: env, stkHex: stkHex, pinnedMldsaHex: mldsa, strict: true))
        XCTAssertEqual(Rescue.checkHelloPq(x, pqSignature: nil, stkHex: stkHex, pinnedMldsaHex: mldsa, strict: true), "strict-requires-hybrid")
        XCTAssertNil(Rescue.checkHelloPq(x, pqSignature: nil, stkHex: stkHex, pinnedMldsaHex: mldsa, strict: false))
        XCTAssertEqual(Rescue.checkHelloPq(x, pqSignature: env, stkHex: stkHex, pinnedMldsaHex: nil, strict: true), "strict-requires-binding")
        var other = x
        other.issuedAt += 1
        XCTAssertEqual(Rescue.checkHelloPq(other, pqSignature: env, stkHex: stkHex, pinnedMldsaHex: mldsa, strict: false), "bad-signature")
        let zeroed = SignatureEnvelope(suite: env.suite, signature: String(repeating: "0", count: 128) + String(env.signature.dropFirst(128)))
        XCTAssertEqual(Rescue.checkHelloPq(x, pqSignature: zeroed, stkHex: stkHex, pinnedMldsaHex: mldsa, strict: false), "bad-signature")
    }

    func testOrderHelpers() throws {
        XCTAssertTrue(Rescue.isServiceId("alice--notes"))
        XCTAssertTrue(Rescue.isServiceId("notes"))
        XCTAssertFalse(Rescue.isServiceId("a--b--c"))
        XCTAssertFalse(Rescue.isServiceId("Notes"))
        XCTAssertEqual(Rescue.newNonce().count, 32)
        let o = OfflineControlOrder(serverDomain: "home.alice.flagship.services", sessionNonce: Rescue.newNonce(), action: .serverShutdown,
                                    target: "home.alice.flagship.services", issuedAt: 1)
        XCTAssertNoThrow(try o.canonicalBytes())
        XCTAssertTrue(OfflineControlOrder.Action.serverRestart.isServerAction)
        XCTAssertFalse(OfflineControlOrder.Action.appStop.isServerAction)
    }
}
