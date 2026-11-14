import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift `flagship/box-claim/v1` port to packages/protocol/test-vectors/box-claim/.
final class BoxClaimVectorTests: XCTestCase {
    private func load() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/box-claim/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("box-claim vectors not found above \(#filePath)")
    }

    private func h(_ v: Any?) -> [UInt8] { PqBin.unhex((v as? String) ?? "") ?? [] }

    private func rand(_ w: Any?) -> BoxClaim.Randomness {
        let o = w as! [String: Any]
        return .init(ephemeralSeed: h(o["ephemeralSeedHex"]), nonce: h(o["nonceHex"]), encapsulation: h(o["encapsulationHex"]))
    }

    private func code(_ f: () throws -> Void) -> String {
        do { try f() } catch let e as BoxClaimError { return e.code } catch { return "\(error)" }
        return "ok"
    }

    private func same(_ a: [String: Any], _ b: Any?) -> Bool {
        NSDictionary(dictionary: a).isEqual(to: b as! [String: Any])
    }

    func testSetupCodes() throws {
        let v = try load()
        for c in v["setupCodes"] as! [[String: Any]] {
            let generated = try BoxClaim.generateSetupCode(randomness: h(c["randomHex"]))
            XCTAssertEqual(generated, c["code"] as? String)
            XCTAssertEqual(BoxClaim.formatSetupCode(generated), c["formatted"] as? String)
            XCTAssertEqual(PqBin.hex(try BoxClaim.setupCodeKey(generated)), c["codeKeyHex"] as? String)
            XCTAssertEqual(try BoxClaim.setupCodeMailboxId(generated), c["mailboxId"] as? String)
            XCTAssertEqual(try BoxClaim.setupCodeLink(generated), c["link"] as? String)
            XCTAssertEqual(BoxClaim.parseSetupCodeLink(c["link"] as! String), generated)
        }
        for n in v["normalize"] as! [[String: Any]] {
            XCTAssertEqual(BoxClaim.normalizeSetupCode(n["input"] as! String), n["output"] as? String)
        }
        XCTAssertNil(BoxClaim.parseSetupCodeLink("https://flagshipserver.com/claim#c=B9D5MPJTB9D5MPJTB9D5&v=2"))
        XCTAssertNil(BoxClaim.parseSetupCodeLink("http://flagshipserver.com/claim#c=B9D5MPJTB9D5MPJTB9D5&v=1"))
        XCTAssertNotEqual(try BoxClaim.generateSetupCode(), try BoxClaim.generateSetupCode())
    }

    func testTranscripts() throws {
        let v = try load()
        let domain = v["serverDomain"] as! String, serial = v["serial"] as! String
        let stk = v["stk"] as! [String: Any]
        let stkSecret = h(stk["ed25519SeedHex"]) + h(stk["mldsaSeedHex"])
        for t in v["transcripts"] as! [[String: Any]] {
            let r = t["randomness"] as! [String: Any]
            let mode = BoxClaim.Mode(rawValue: t["mode"] as! String)!
            let state = BoxClaim.AdvertState(rawValue: t["state"] as! String)!
            let codeStr = t["code"] as? String
            let start = try BoxClaim.PhoneStart(mode: mode, code: codeStr, randomness: rand(r["phone"]))
            XCTAssertTrue(same(start.hello.json, t["hello"]), "\(t["name"]!) hello")
            let box = try BoxClaim.BoxPending(hello: start.hello.json, state: state,
                                              codeKey: try codeStr.map { try BoxClaim.setupCodeKey($0) }, randomness: rand(r["box"]))
            XCTAssertTrue(same(box.accept.json, t["accept"]), "\(t["name"]!) accept")
            let (fin, pp) = try start.finish(accept: t["accept"], randomness: rand(r["phone"]))
            XCTAssertTrue(same(fin, t["finish"]), "\(t["name"]!) finish")
            let (ready, boxCh) = try box.complete(finish: t["finish"])
            XCTAssertTrue(same(ready, t["ready"]), "\(t["name"]!) ready")
            let phone = try pp.confirm(ready: t["ready"])
            XCTAssertEqual(phone.transcriptHex, t["transcriptHex"] as? String)
            XCTAssertEqual(boxCh.transcriptHex, t["transcriptHex"] as? String)
            XCTAssertEqual(phone.sessionIdHex, t["sessionIdHex"] as? String)
            XCTAssertEqual(phone.advertState, state)
            for rec in t["records"] as! [[String: Any]] {
                let fromPhone = rec["from"] as! String == "phone"
                let (sender, receiver) = fromPhone ? (phone, boxCh) : (boxCh, phone)
                let pt = rec["plaintext"] as! String
                XCTAssertEqual(PqBin.hex(try sender.seal(Array(pt.utf8))), rec["recordHex"] as? String)
                let opened = try receiver.open(h(rec["recordHex"]))
                XCTAssertEqual(String(bytes: opened, encoding: .utf8), pt)
                let obj = try JSONSerialization.jsonObject(with: Data(pt.utf8))
                if fromPhone {
                    XCTAssertEqual(try BoxClaim.PhoneMessage.parse(obj).jsonText, pt)
                } else {
                    _ = try BoxClaim.BoxMessage.parse(obj)
                }
            }
            let receipt = try BoxClaim.verifyReceipt(t["receipt"], transcriptHex: t["transcriptHex"] as! String, mode: mode,
                                                     serverDomain: domain, serial: serial)
            XCTAssertEqual(receipt.stkPubHex, String((stk["hybridPubHex"] as! String).prefix(64)))
            let unsigned = BoxClaim.Receipt(mode: receipt.mode, serverDomain: receipt.serverDomain, serial: receipt.serial,
                                            stkHybridPub: receipt.stkHybridPub, bootKeyBindingSha256: receipt.bootKeyBindingSha256,
                                            model: receipt.model, imageVersion: receipt.imageVersion, transcript: receipt.transcript,
                                            issuedAt: receipt.issuedAt)
            let resigned = try unsigned.signed { p, m in try PqHybrid.hybridSign(secretKey: stkSecret, purpose: p, payload: m, deterministic: true) }
            _ = try BoxClaim.verifyReceipt(resigned.json, transcriptHex: receipt.transcript, mode: mode, serverDomain: domain, serial: serial)
            var bad = t["receipt"] as! [String: Any]
            bad["model"] = "Other"
            XCTAssertEqual(code { _ = try BoxClaim.verifyReceipt(bad, transcriptHex: t["transcriptHex"] as! String, mode: mode, serverDomain: domain, serial: serial) }, "bad-receipt")
            XCTAssertEqual(code { _ = try BoxClaim.verifyReceipt(t["receipt"], transcriptHex: t["transcriptHex"] as! String, mode: mode, serverDomain: domain, serial: "another-serial-01") }, "bad-receipt")
        }
    }

    private func run(_ mode: BoxClaim.Mode, _ state: BoxClaim.AdvertState, phoneCode: String?, boxCode: String?, _ w: Any?) throws
        -> (phone: BoxClaim.Channel, box: BoxClaim.Channel) {
        let r = w as! [String: Any]
        let s = try BoxClaim.PhoneStart(mode: mode, code: phoneCode, randomness: rand(r["phone"]))
        let b = try BoxClaim.BoxPending(hello: s.hello.json, state: state, codeKey: try boxCode.map { try BoxClaim.setupCodeKey($0) }, randomness: rand(r["box"]))
        let f = try s.finish(accept: b.accept.json, randomness: rand(r["phone"]))
        let c = try b.complete(finish: f.finish)
        return (try f.pending.confirm(ready: c.ready), c.channel)
    }

    func testNegatives() throws {
        let v = try load()
        var by: [String: [String: Any]] = [:]
        for n in v["negatives"] as! [[String: Any]] { by[n["name"] as! String] = n }
        let transcripts = v["transcripts"] as! [[String: Any]]
        let CODE = transcripts[2]["code"] as! String
        let other = (v["setupCodes"] as! [[String: Any]])[1]["code"] as! String

        let wc = by["wrong-code"]!
        XCTAssertEqual(code { _ = try self.run(.code, .unclaimed, phoneCode: other, boxCode: CODE, wc["randomness"]) }, wc["expect"] as? String)

        let bw = by["box-without-code"]!
        let bwr = bw["randomness"] as! [String: Any]
        let s0 = try BoxClaim.PhoneStart(mode: .code, code: CODE, randomness: rand(bwr["phone"]))
        XCTAssertEqual(code { _ = try BoxClaim.BoxPending(hello: s0.hello.json, state: .unclaimed, codeKey: nil, randomness: self.rand(bwr["box"])) }, bw["expect"] as? String)

        for mode in [BoxClaim.Mode.open, .code] {
            let n = by["state-forgery-\(mode.rawValue)"]!
            let r = n["randomness"] as! [String: Any]
            let c: String? = mode == .code ? CODE : nil
            let s = try BoxClaim.PhoneStart(mode: mode, code: c, randomness: rand(r["phone"]))
            let b = try BoxClaim.BoxPending(hello: s.hello.json, state: .resetWindow, codeKey: try c.map { try BoxClaim.setupCodeKey($0) }, randomness: rand(r["box"]))
            var forged = b.accept.json
            forged["state"] = "unclaimed"
            let f = try s.finish(accept: forged, randomness: rand(r["phone"]))
            XCTAssertEqual(code { _ = try b.complete(finish: f.finish) }, n["expect"] as? String)
        }

        let sc = try BoxClaim.PhoneStart(mode: .code, code: CODE)
        let so = try BoxClaim.PhoneStart(mode: .open)
        var openHello = so.hello.json
        openHello["ephemeralPub"] = sc.hello.ephemeralPub
        let downgraded = try BoxClaim.BoxPending(hello: openHello, state: .unclaimed, codeKey: nil)
        XCTAssertEqual(code { _ = try sc.finish(accept: downgraded.accept.json) }, by["mode-downgrade"]!["expect"] as? String)

        let rk = by["relay-key-swap"]!
        let rkr = rk["randomness"] as! [String: Any]
        let a = try run(.open, .unclaimed, phoneCode: nil, boxCode: nil, rkr["phoneToRelay"])
        let bb = try run(.open, .unclaimed, phoneCode: nil, boxCode: nil, rkr["relayToBox"])
        XCTAssertNotEqual(a.phone.transcriptHex, bb.box.transcriptHex)
        var forwarded = transcripts[0]["receipt"] as! [String: Any]
        forwarded["transcript"] = bb.box.transcriptHex
        XCTAssertEqual(code { _ = try BoxClaim.verifyReceipt(forwarded, transcriptHex: a.phone.transcriptHex, mode: .open, serverDomain: v["serverDomain"] as! String, serial: v["serial"] as! String) }, rk["expect"] as? String)

        let rr = by["record-replay"]!
        let t = try run(.open, .unclaimed, phoneCode: nil, boxCode: nil, rr["randomness"])
        let r0 = try t.phone.seal(Array(BoxClaim.PhoneMessage.arm.jsonText.utf8))
        let r1 = try t.phone.seal(Array(BoxClaim.PhoneMessage.wifiScan.jsonText.utf8))
        XCTAssertEqual(code { _ = try t.box.open(r1) }, "replay")
        _ = try t.box.open(r0)
        XCTAssertEqual(code { _ = try t.box.open(r0) }, rr["expect"] as? String)
        let fromBox = try t.box.seal(Array(#"{"t":"armed"}"#.utf8))
        XCTAssertEqual(code { _ = try t.box.open(fromBox) }, "decrypt-failed")
    }

    func testPressChecks() throws {
        let v = try load()
        for p in v["press"] as! [[String: Any]] {
            let n = { (k: String) in (p[k] as! NSNumber).int64Value }
            let verdict = BoxClaim.judgePressReport(armSentAt: n("armSentAt"), instructionAt: n("instructionAt"), atMs: n("atMs"),
                                                    count: Int(n("count")), long: p["long"] as! Bool, receivedAt: n("receivedAt"))
            XCTAssertEqual(verdict.rawValue, p["verdict"] as? String, p["name"] as? String ?? "")
        }
        XCTAssertEqual(try BoxClaim.instructionPauseMs(randomness: [0, 0]), BoxClaim.instructionPauseMinMs)
        XCTAssertEqual(try BoxClaim.instructionPauseMs(randomness: [255, 255]), BoxClaim.instructionPauseMaxMs)
        for _ in 0..<50 {
            let ms = try BoxClaim.instructionPauseMs()
            XCTAssertTrue((BoxClaim.instructionPauseMinMs...BoxClaim.instructionPauseMaxMs).contains(ms))
        }
    }

    func testClaimKey() throws {
        let v = try load()
        let k = v["claimKey"] as! [String: Any]
        let f = k["fields"] as! [String: Any]
        let key = BoxClaim.ClaimKey(username: f["username"] as! String, serial: f["serial"] as! String, serverDomain: f["serverDomain"] as! String,
                                    stkPubHex: f["stkPubHex"] as! String, issuedAt: (f["issuedAt"] as! NSNumber).int64Value)
        XCTAssertEqual(String(bytes: key.canonical, encoding: .utf8), k["canonical"] as? String)
        let signer = try Curve25519.Signing.PrivateKey(rawRepresentation: h(k["signerSeedHex"]))
        XCTAssertEqual(PqBin.hex(Array(signer.publicKey.rawRepresentation)), k["signerPubHex"] as? String)
        XCTAssertTrue(key.verify(signature: h(k["signatureHex"]), publicKey: h(k["signerPubHex"])))
        XCTAssertTrue(key.verify(signature: try key.sign(with: signer), publicKey: h(k["signerPubHex"])))
        let other = BoxClaim.ClaimKey(username: key.username, serial: key.serial, serverDomain: key.serverDomain, stkPubHex: String(repeating: "00", count: 32), issuedAt: key.issuedAt)
        XCTAssertFalse(other.verify(signature: h(k["signatureHex"]), publicKey: h(k["signerPubHex"])))
    }

    func testFrames() throws {
        let v = try load()
        let f = v["frames"] as! [String: Any]
        let frames = try BoxClaim.fragment(h(f["messageHex"]), mtu: (f["mtu"] as! NSNumber).intValue)
        XCTAssertEqual(frames.map(PqBin.hex), f["frames"] as? [String])
        let r = BoxClaim.Reassembler()
        var out: [UInt8]?
        for fr in frames { out = try r.push(fr) }
        XCTAssertEqual(out.map(PqBin.hex), f["messageHex"] as? String)
        let many = try BoxClaim.fragment([UInt8](repeating: 0, count: 100), mtu: 23)
        let r2 = BoxClaim.Reassembler()
        XCTAssertEqual(code { _ = try r2.push(many[1]) }, "claim-malformed")
        _ = try r2.push(many[0])
        XCTAssertEqual(code { _ = try r2.push(many[0]) }, "claim-malformed")
    }

    func testPhoneMessages() throws {
        let wifi = BoxClaim.WiFiConfig(ssid: "Home|Net", psk: "pass|word1", regulatoryRegion: "DE", issuedAt: 1)
        let text = BoxClaim.PhoneMessage.network(wifi).jsonText
        XCTAssertEqual(try BoxClaim.PhoneMessage.parse(try JSONSerialization.jsonObject(with: Data(text.utf8))), .network(wifi))
        XCTAssertEqual(code { _ = try BoxClaim.PhoneMessage.parse(["t": "arm", "x": 1]) }, "claim-malformed")
        XCTAssertFalse(BoxClaim.WiFiConfig(ssid: "Home", psk: "short", regulatoryRegion: "DE", issuedAt: 1).isValid)
        XCTAssertFalse(BoxClaim.WiFiConfig(ssid: String(repeating: "x", count: 33), psk: "", regulatoryRegion: "", issuedAt: 1).isValid)
        let claim = BoxClaim.PhoneMessage.claim(recipe: "{\"a\":\"/\\\"\"}").jsonText
        XCTAssertEqual(try BoxClaim.PhoneMessage.parse(try JSONSerialization.jsonObject(with: Data(claim.utf8))), .claim(recipe: "{\"a\":\"/\\\"\"}"))
    }
}
