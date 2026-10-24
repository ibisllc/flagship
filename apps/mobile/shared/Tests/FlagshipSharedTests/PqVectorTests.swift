import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift PQ ports to the shared vectors every port reads:
/// packages/protocol/test-vectors/pq-hybrid/vectors.json (+ xwing-draft11-kats.json),
/// packages/protocol/test-vectors/pq-binding/vectors.json and
/// packages/protocol/test-vectors/assurance-policy/vectors.json.
final class PqVectorTests: XCTestCase {
    private func load(_ rel: String) throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/" + rel)
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("\(rel) not found above \(#filePath)")
    }

    private func hybrid() throws -> [String: Any] { try load("test-vectors/pq-hybrid/vectors.json") }
    private func h(_ v: Any?) -> [UInt8] { PqBin.unhex((v as? String) ?? "") ?? { XCTFail("bad hex \(String(describing: v))"); return [] }() }
    private func x(_ b: [UInt8]) -> String { PqBin.hex(b) }
    private func u64(_ v: Any?) -> UInt64? { (v as? NSNumber).map { $0.uint64Value } }

    private func code(_ f: () throws -> Void) -> String {
        do { try f(); return "ok" } catch let e as PqHybridError { return e.code } catch let e as PqTrustError { return e.code } catch { return "other:\(error)" }
    }

    // MARK: pq-hybrid

    func testXWingDraft11Kats() throws {
        let v = try load("test-vectors/pq-hybrid/xwing-draft11-kats.json")
        for k in v["vectors"] as! [[String: Any]] {
            let pk = try XCTUnwrap(PqPrim.xwingPublicKey(h(k["seed"])))
            XCTAssertEqual(x(pk), k["pk"] as? String)
            let e = try XCTUnwrap(PqPrim.xwingEncapsulate(pk, h(k["eseed"])))
            XCTAssertEqual(x(e.ct), k["ct"] as? String)
            XCTAssertEqual(x(e.ss), k["ss"] as? String)
            XCTAssertEqual(PqPrim.xwingDecapsulate(h(k["ct"]), h(k["seed"])).map(x), k["ss"] as? String)
        }
    }

    func testKeyIdsAndRawKem() throws {
        let v = try hybrid()
        for k in v["keyIds"] as! [[String: Any]] {
            XCTAssertEqual(x(PqHybrid.pqKeyId(suite: UInt16((k["suite"] as! NSNumber).intValue), publicKey: h(k["publicKey"]))), k["keyId"] as? String)
        }
        for k in v["kem"] as! [[String: Any]] {
            let pk = try XCTUnwrap(PqPrim.xwingPublicKey(h(k["seed"])))
            XCTAssertEqual(x(pk), k["publicKey"] as? String)
            let e = try XCTUnwrap(PqPrim.xwingEncapsulate(pk, h(k["eseed"])))
            XCTAssertEqual(x(e.ct), k["enc"] as? String)
            XCTAssertEqual(x(e.ss), k["sharedSecret"] as? String)
            XCTAssertEqual(PqPrim.xwingDecapsulate(e.ct, h(k["seed"])).map(x), k["sharedSecret"] as? String)
        }
    }

    private func header(_ o: [String: Any]) -> EnvelopeHeaderV2 {
        EnvelopeHeaderV2(purpose: o["purpose"] as! String, suite: UInt16((o["suite"] as! NSNumber).intValue),
                         senderKeyId: h(o["senderKeyId"]), recipientKeyId: o["recipientKeyId"].map { h($0) },
                         installationId: o["installationId"].map { h($0) }, authorityGeneration: u64(o["authorityGeneration"]),
                         sessionNonce: o["sessionNonce"].map { h($0) }, policyDigest: o["policyDigest"].map { h($0) },
                         issuedAt: u64(o["issuedAt"])!, expiresAt: u64(o["expiresAt"]), bodyLen: (o["bodyLen"] as! NSNumber).intValue)
    }

    private func options(_ o: [String: Any]) -> HybridSealOptions {
        HybridSealOptions(purpose: o["purpose"] as! String, senderKeyId: h(o["senderKeyId"]), issuedAt: u64(o["issuedAt"])!,
                          expiresAt: u64(o["expiresAt"]), installationId: o["installationId"].map { h($0) },
                          authorityGeneration: u64(o["authorityGeneration"]), sessionNonce: o["sessionNonce"].map { h($0) },
                          policyDigest: o["policyDigest"].map { h($0) })
    }

    func testEnvelopeHeaders() throws {
        let env = try hybrid()["envelope"] as! [String: Any]
        for c in env["valid"] as! [[String: Any]] {
            let hex = c["hex"] as! String
            XCTAssertEqual(x(try PqHybrid.encodeEnvelopeHeader(header(c["header"] as! [String: Any]))), hex)
            let d = try PqHybrid.decodeEnvelopeHeader(h(hex))
            XCTAssertEqual(d.length, hex.count / 2)
            XCTAssertEqual(x(try PqHybrid.encodeEnvelopeHeader(d.header)), hex)
        }
        let invalid = env["invalid"] as! [[String: Any]]
        XCTAssertEqual(invalid.count, 21)
        for c in invalid {
            XCTAssertEqual(code { _ = try PqHybrid.decodeEnvelopeHeader(h(c["hex"])) }, c["expect"] as? String, c["name"] as! String)
        }
    }

    func testSealVectors() throws {
        let seal = try hybrid()["seal"] as! [String: Any]
        let valid = seal["valid"] as! [[String: Any]]
        for c in valid {
            let kp = try PqHybrid.hybridSealKeygen(seed: h(c["recipientSeed"]))
            XCTAssertEqual(x(kp.publicKey), c["recipientPublicKey"] as? String)
            let ctx = (c["context"] as! [String]).map { h($0) }
            let opts = options(c["options"] as! [String: Any])
            let sealed = try PqHybrid.hybridSealWithRandomness(recipientPublicKey: kp.publicKey, options: opts, context: ctx,
                                                               plaintext: h(c["plaintext"]), eseed: h(c["eseed"]))
            XCTAssertEqual(x(sealed), c["sealed"] as? String, c["name"] as! String)
            let opened = try PqHybrid.hybridOpen(recipientSecretKey: kp.secretKey, expectedPurpose: opts.purpose, context: ctx, sealed: h(c["sealed"]))
            XCTAssertEqual(x(opened.plaintext), c["plaintext"] as? String)
            XCTAssertEqual(opened.header.senderKeyId, opts.senderKeyId)
        }
        // Randomized path.
        let c = valid[0]
        let kp = try PqHybrid.hybridSealKeygen(seed: h(c["recipientSeed"]))
        let ctx = (c["context"] as! [String]).map { h($0) }
        let opts = options(c["options"] as! [String: Any])
        let a = try PqHybrid.hybridSeal(recipientPublicKey: kp.publicKey, options: opts, context: ctx, plaintext: h(c["plaintext"]))
        let b = try PqHybrid.hybridSeal(recipientPublicKey: kp.publicKey, options: opts, context: ctx, plaintext: h(c["plaintext"]))
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(x(try PqHybrid.hybridOpen(recipientSecretKey: kp.secretKey, expectedPurpose: opts.purpose, context: ctx, sealed: a).plaintext), c["plaintext"] as? String)

        let invalid = seal["invalid"] as! [[String: Any]]
        XCTAssertEqual(invalid.count, 24)
        for c in invalid {
            XCTAssertEqual(code {
                _ = try PqHybrid.hybridOpen(recipientSecretKey: h(c["recipientSeed"]), expectedPurpose: c["expectedPurpose"] as! String,
                                            context: (c["context"] as! [String]).map { h($0) }, sealed: h(c["sealed"]))
            }, c["expect"] as? String, c["name"] as! String)
        }
        for c in seal["rejectPublicKeys"] as! [[String: Any]] {
            XCTAssertEqual(code { try PqHybrid.parseHybridSealPublicKey(h(c["publicKey"])) }, c["expect"] as? String, c["name"] as! String)
        }
        for r in seal["rejectInputs"] as! [[String: Any]] {
            var o = opts
            o.purpose = r["purpose"] as! String
            let ctx = Array(repeating: [UInt8](), count: (r["contextFields"] as! NSNumber).intValue)
            let pt = [UInt8](repeating: 0, count: (r["plaintextLen"] as! NSNumber).intValue)
            XCTAssertEqual(code {
                _ = try PqHybrid.hybridSealWithRandomness(recipientPublicKey: h(c["recipientPublicKey"]), options: o, context: ctx, plaintext: pt, eseed: h(c["eseed"]))
            }, r["expect"] as? String, r["name"] as! String)
        }
    }

    func testSigVectors() throws {
        let sig = try hybrid()["sig"] as! [String: Any]
        let valid = sig["valid"] as! [[String: Any]]
        for c in valid {
            let kp = try PqHybrid.hybridSigKeygen(edSeed: h(c["edSeed"]), mldsaSeed: h(c["mldsaSeed"]))
            XCTAssertEqual(x(kp.publicKey), c["publicKey"] as? String)
            XCTAssertEqual(x(PqHybrid.pqKeyId(suite: 2, publicKey: kp.publicKey)), c["keyId"] as? String)
            let purpose = c["purpose"] as! String
            let payload = h(c["payload"])
            let m = try PqHybrid.hybridSigMessage(publicKey: kp.publicKey, purpose: purpose, payload: payload)
            XCTAssertEqual(x(Array(SHA512.hash(data: m))), c["messageSha512"] as? String)
            // The ML-DSA half is deterministic (rnd = 0^32) and must match byte for byte; CryptoKit's
            // Ed25519 half is hedged, so the whole signature is checked by verifying it.
            let det = try PqHybrid.hybridSign(secretKey: kp.secretKey, purpose: purpose, payload: payload, deterministic: true)
            XCTAssertEqual(x(Array(det[64...])), String((c["signature"] as! String).dropFirst(128)), c["name"] as! String)
            XCTAssertEqual(code { try PqHybrid.hybridVerify(publicKey: kp.publicKey, purpose: purpose, payload: payload, signature: det) }, "ok")
            XCTAssertEqual(code { try PqHybrid.hybridVerify(publicKey: kp.publicKey, purpose: purpose, payload: payload, signature: h(c["signature"])) }, "ok")
            let hedged = try PqHybrid.hybridSign(secretKey: kp.secretKey, purpose: purpose, payload: payload)
            XCTAssertEqual(code { try PqHybrid.hybridVerify(publicKey: kp.publicKey, purpose: purpose, payload: payload, signature: hedged) }, "ok")
        }
        let invalid = sig["invalid"] as! [[String: Any]]
        XCTAssertEqual(invalid.count, 18)
        for c in invalid {
            XCTAssertEqual(code {
                try PqHybrid.hybridVerify(publicKey: h(c["publicKey"]), purpose: c["purpose"] as! String, payload: h(c["payload"]), signature: h(c["signature"]))
            }, c["expect"] as? String, c["name"] as! String)
        }
        let big = sig["payloadTooLarge"] as! [String: Any]
        XCTAssertEqual(code {
            try PqHybrid.hybridVerify(publicKey: h(big["publicKey"]), purpose: big["purpose"] as! String,
                                      payload: [UInt8](repeating: 0, count: (big["payloadLen"] as! NSNumber).intValue), signature: h(big["signature"]))
        }, big["expect"] as? String)

        let s = sig["classicalStrip"] as! [String: Any]
        let edPk = try Curve25519.Signing.PublicKey(rawRepresentation: h(s["publicKeyEd25519"]))
        XCTAssertTrue(edPk.isValidSignature(h(s["signatureEd25519"]), for: h(s["signedMessage"])))
        for m in s["mustNotVerifyOver"] as! [[String: Any]] {
            XCTAssertFalse(edPk.isValidSignature(h(s["signatureEd25519"]), for: h(m["message"])), m["name"] as! String)
        }
        let c = valid[1]
        let full = h(c["signature"]), pk = h(c["publicKey"])
        let m = try PqHybrid.hybridSigMessage(publicKey: pk, purpose: c["purpose"] as! String, payload: h(c["payload"]))
        let ml = Array(full[64...]), mlPk = Array(pk[32...])
        let tag = PqBin.utf8(PqHybrid.tagHybridSigEd25519MlDsa65V1)
        XCTAssertTrue(PqPrim.mldsaVerify(mlPk, m, ctx: tag, sig: ml))
        XCTAssertFalse(PqPrim.mldsaVerify(mlPk, m, ctx: [], sig: ml))
        XCTAssertFalse(PqPrim.mldsaVerify(mlPk, h(c["payload"]), ctx: tag, sig: ml))
    }

    func testStrictPointCheck() {
        // Identity, a small-order point, a non-canonical y, the base point (valid).
        var identity = [UInt8](repeating: 0, count: 32); identity[0] = 1
        XCTAssertFalse(PqPrim.edPoint(identity[...]))
        XCTAssertFalse(PqPrim.edPoint([UInt8](repeating: 0, count: 32)[...]))
        var nonCanonical = [UInt8](repeating: 0xff, count: 32); nonCanonical[31] = 0x7f; nonCanonical[0] = 0xee
        XCTAssertFalse(PqPrim.edPoint(nonCanonical[...]))
        let base = PqBin.unhex("5866666666666666666666666666666666666666666666666666666666666666")!
        XCTAssertTrue(PqPrim.edPoint(base[...]))
        let key = Curve25519.Signing.PrivateKey()
        XCTAssertTrue(PqPrim.edPoint(PqBytes(key.publicKey.rawRepresentation)[...]))
    }

    // MARK: pq-binding

    private func binding() throws -> [String: Any] { try load("test-vectors/pq-binding/vectors.json") }

    private func expectation(_ o: [String: Any]) -> PqBindingExpectation {
        PqBindingExpectation(role: o["role"] as! String, subjectId: o["subjectId"] as! String, ed25519PubHex: o["ed25519PubHex"] as! String,
                             mldsaPubHex: o["mldsaPubHex"] as? String, now: (o["now"] as! NSNumber).int64Value,
                             minIssuedAt: (o["minIssuedAt"] as? NSNumber)?.int64Value)
    }

    private func policy(_ p: [String: Any]) -> PolicyState {
        var s = AssurancePolicy.legacyState(PolicyScope(kind: .installation, id: "home.alice.flagship.services"))
        s.profile = AssuranceProfile(rawValue: p["profile"] as! String)!
        s.rollout = RolloutState(rawValue: p["rollout"] as! String)!
        return s
    }

    func testBindingVectors() throws {
        let v = try binding()
        let valid = v["bindings"] as! [String: Any]
        let ok = valid["valid"] as! [[String: Any]]
        XCTAssertEqual(ok.count, 5)
        for c in ok {
            let wire = c["wire"] as! [String: Any]
            let parsed = try PqTrust.pqKeyBindingFromWire(wire)
            XCTAssertEqual(x(try PqTrust.canonicalPqKeyBinding(parsed.statement)), c["statementHex"] as? String)
            let b = try PqTrust.verifyPqKeyBinding(wire, expectation(c["expect"] as! [String: Any]))
            XCTAssertEqual(b.mldsaPubHex, wire["mldsaPubHex"] as? String)
        }
        let bad = valid["invalid"] as! [[String: Any]]
        XCTAssertEqual(bad.count, 31)
        for c in bad {
            XCTAssertEqual(code { _ = try PqTrust.verifyPqKeyBinding(c["wire"], self.expectation(c["expect"] as! [String: Any])) },
                           c["code"] as? String, c["name"] as! String)
        }
        // Sign a binding as the vectors do: everything but the hedged Ed25519 half matches.
        let stk = ok.first { $0["name"] as? String == "box-stk" }!
        let wire = try PqTrust.pqKeyBindingFromWire(stk["wire"])
        let signer = (v["signers"] as! [[String: Any]]).first { $0["name"] as? String == "A" }!
        let secret = h(signer["edSeedHex"]) + h(signer["mldsaSeedHex"])
        let signed = try PqTrust.signPqKeyBinding(wire.statement) { purpose, payload in
            try PqHybrid.hybridSign(secretKey: secret, purpose: purpose, payload: payload, deterministic: true)
        }
        XCTAssertEqual(String(signed.signature.dropFirst(128)), String(wire.signature.dropFirst(128)))
        XCTAssertEqual(signed.statement, wire.statement)
        XCTAssertNoThrow(try PqTrust.verifyPqKeyBinding(signed, expectation(stk["expect"] as! [String: Any])))
    }

    func testGateVectors() throws {
        let v = try binding()
        let ok = (v["bindings"] as! [String: Any])["valid"] as! [[String: Any]]
        let gate = v["gate"] as! [[String: Any]]
        XCTAssertEqual(gate.count, 27)
        for c in gate {
            let name = c["name"] as! String
            let vb = ok.first { $0["name"] as? String == c["binding"] as? String }
            let b = try vb.map { try PqTrust.verifyPqKeyBinding($0["wire"], expectation($0["expect"] as! [String: Any])) }
            let env = c["envelope"] as! [String: Any]
            let expect = c["expect"] as! [String: Any]
            var verdict: CriticalSignatureVerdict?
            let got = code {
                verdict = try PqTrust.verifyCriticalSignature(
                    message: h(c["messageHex"]), expectedPurpose: c["expectedPurpose"] as! String,
                    envelope: SignatureEnvelope(suite: env["suite"] as! String, signature: env["signature"] as! String),
                    signerEd25519PubHex: c["signerEd25519PubHex"] as! String, binding: b, policy: policy(c["policy"] as! [String: Any]))
            }
            if expect["ok"] as? Bool == true {
                XCTAssertEqual(got, "ok", name)
                XCTAssertEqual(verdict?.suite.rawValue, expect["suite"] as? String, name)
                XCTAssertEqual(verdict?.strict, expect["strict"] as? Bool, name)
            } else {
                XCTAssertEqual(got, expect["code"] as? String, name)
            }
        }
    }

    // MARK: assurance-policy

    func testAssurancePolicyVectors() throws {
        let v = try load("test-vectors/assurance-policy/vectors.json")
        XCTAssertEqual(v["tag"] as? String, AssurancePolicy.tag)
        for c in v["cases"] as! [[String: Any]] {
            let data = try JSONSerialization.data(withJSONObject: c["change"]!)
            let change = try JSONDecoder().decode(AssurancePolicyChange.self, from: data)
            XCTAssertEqual(String(decoding: try AssurancePolicy.canonical(change), as: UTF8.self), c["canonical"] as? String)
            XCTAssertEqual(try AssurancePolicy.digest(change), c["digest"] as? String)
        }
    }

    // MARK: strict-reentry

    func testStrictReentryVectors() throws {
        let v = try load("test-vectors/strict-reentry/vectors.json")
        XCTAssertEqual(v["tag"] as? String, StrictReentry.tag)
        func binding(_ o: Any?) -> StrictReentry.Binding? {
            guard let d = o as? [String: Any] else { return nil }
            return StrictReentry.Binding(role: d["role"] as! String, subjectId: d["subjectId"] as! String,
                                         ed25519PubHex: d["ed25519PubHex"] as! String, mldsaPubHex: d["mldsaPubHex"] as! String)
        }
        func inputs(_ d: [String: Any]) -> StrictReentry.Inputs {
            let scope = d["scope"] as! [String: Any]
            return StrictReentry.Inputs(
                account: d["account"] as! String,
                scope: PolicyScope(kind: PolicyScopeKind(rawValue: scope["kind"] as! String)!, id: scope["id"] as! String),
                leftStrictAt: (d["leftStrictAt"] as! NSNumber).int64Value,
                devices: (d["devices"] as! [Any]).compactMap(binding),
                deviceCount: (d["deviceCount"] as! NSNumber).intValue,
                adminRoot: binding(d["adminRoot"]),
                server: binding(d["server"])!,
                recoveryChecked: d["recoveryChecked"] as! Bool,
                recoveryCheckedAt: (d["recoveryCheckedAt"] as? NSNumber)?.int64Value,
                nonceHex: d["nonceHex"] as! String,
                checkedAt: (d["checkedAt"] as! NSNumber).int64Value)
        }
        for c in v["cases"] as! [[String: Any]] {
            let i = inputs(c["inputs"] as! [String: Any])
            XCTAssertEqual(try StrictReentry.texts(i), c["texts"] as? [String])
            let e = try StrictReentry.evidence(i)
            let want = c["evidence"] as! [String: String]
            XCTAssertEqual(e.verifierChecksDigest, want["verifierChecksDigest"])
            XCTAssertEqual(e.enrollmentDigest, want["enrollmentDigest"])
            XCTAssertEqual(e.rekeyReceiptDigest, want["rekeyReceiptDigest"])
            XCTAssertEqual(e.recoveryTestDigest, want["recoveryTestDigest"])
        }
        for r in v["refusals"] as! [[String: Any]] {
            XCTAssertThrowsError(try StrictReentry.evidence(inputs(r["inputs"] as! [String: Any]))) { e in
                XCTAssertEqual((e as? StrictReentry.Refusal)?.code, r["code"] as? String)
            }
        }
    }
}
