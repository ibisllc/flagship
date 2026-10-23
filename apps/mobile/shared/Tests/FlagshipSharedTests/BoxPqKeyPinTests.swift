import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipAPI

/// The box's ML-DSA key pin (boxKeyPin.ts `decideBoxPqKeyPin`, webapp `acceptStkPqBinding`),
/// against the box-stk binding in packages/protocol/test-vectors/pq-binding/vectors.json.
final class BoxPqKeyPinTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/pq-binding/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    private struct Fixture {
        let domain: String
        let stkHex: String
        let wire: [String: Any]
        let otherWire: [String: Any]
        let secretA: [UInt8]
        let now: Int64
    }

    private func fixture() throws -> Fixture {
        let v = try vectors()
        let b = v["bindings"] as! [String: Any]
        let stk = (b["valid"] as! [[String: Any]]).first { $0["name"] as? String == "box-stk" }!
        let sub = (b["invalid"] as! [[String: Any]]).first { $0["name"] as? String == "pq-key-substituted" }!
        let a = (v["signers"] as! [[String: Any]]).first { $0["name"] as? String == "A" }!
        let wire = stk["wire"] as! [String: Any]
        return Fixture(domain: wire["subjectId"] as! String, stkHex: wire["ed25519PubHex"] as! String, wire: wire,
                       otherWire: sub["wire"] as! [String: Any],
                       secretA: PqBin.unhex(a["edSeedHex"] as! String)! + PqBin.unhex(a["mldsaSeedHex"] as! String)!,
                       now: (v["now"] as! NSNumber).int64Value)
    }

    func testPinsTheMlDsaKeyOnlyUnderThePinnedStk() throws {
        let f = try fixture()
        let pins = BoxKeyPins(defaults: nil, now: { f.now })
        XCTAssertNil(try pins.acceptStkPqBinding(username: "alice", serverDomain: f.domain, wire: f.wire), "no STK pin yet")
        pins.repin(username: "alice", serverDomain: f.domain, stkHex: String(repeating: "ab", count: 32))
        XCTAssertNil(try pins.acceptStkPqBinding(username: "alice", serverDomain: f.domain, wire: f.wire), "another STK pinned")
        pins.repin(username: "alice", serverDomain: f.domain, stkHex: f.stkHex)
        let k = try pins.acceptStkPqBinding(username: "alice", serverDomain: f.domain, wire: f.wire)
        XCTAssertEqual(k, f.wire["mldsaPubHex"] as? String)
        XCTAssertEqual(pins.pinnedBoxPqKey(username: "alice", serverDomain: f.domain), k)
        XCTAssertEqual(try pins.acceptStkPqBinding(username: "alice", serverDomain: f.domain, wire: f.wire), k, "same binding again")
    }

    func testAChangedMlDsaKeyIsAKeyChange() throws {
        let f = try fixture()
        let pins = BoxKeyPins(defaults: nil, now: { f.now })
        pins.repin(username: "alice", serverDomain: f.domain, stkHex: f.stkHex)
        try pins.acceptStkPqBinding(username: "alice", serverDomain: f.domain, wire: f.wire)
        // A binding naming another ML-DSA key for the same STK.
        var other = f.wire
        other["mldsaPubHex"] = f.otherWire["mldsaPubHex"]
        XCTAssertThrowsError(try pins.acceptStkPqBinding(username: "alice", serverDomain: f.domain, wire: other)) {
            XCTAssertTrue($0 is BoxKeyChangedError)
        }
    }

    private func bootWire(_ f: Fixture, bootPub: String, issuedAt: Int64, hybrid: Bool) throws -> BootKeyBindingWire {
        let edKey = try Curve25519.Signing.PrivateKey(rawRepresentation: Array(f.secretA[0..<32]))
        let v1 = BoxKeyPins.canonicalBootKeyBinding(serverDomain: f.domain, bootPubHex: bootPub, issuedAt: issuedAt)!
        let v2 = Array([BoxKeyPins.bootKeyBindingV2Tag, f.domain, bootPub, String(issuedAt)].joined(separator: "|").utf8)
        let hyb = hybrid ? PqBin.hex(try PqHybrid.hybridSign(secretKey: f.secretA, purpose: BoxKeyPins.bootKeyBindingV2Tag, payload: v2)) : nil
        return BootKeyBindingWire(binding: .init(serverDomain: f.domain, bootPubHex: bootPub, issuedAt: issuedAt),
                                  signature: PqBin.hex(PqBytes(try edKey.signature(for: v1))), hybridSignature: hyb)
    }

    func testOncePinnedTheBootKeyNeedsTheHybridSignature() async throws {
        let f = try fixture()
        let boot = PqBin.hex(PqBytes(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation))
        let pins = BoxKeyPins(defaults: nil, now: { f.now })
        pins.repin(username: "alice", serverDomain: f.domain, stkHex: f.stkHex)
        let mailbox = MockSecretMailboxClient()

        // Classical-only binding while no ML-DSA key is pinned: accepted (compatibility).
        mailbox.bootKeyBindings[f.domain] = try bootWire(f, bootPub: boot, issuedAt: 5, hybrid: false)
        var got = await BootKey.forServer(username: "alice", serverDomain: f.domain, mailbox: mailbox, pins: pins)
        XCTAssertEqual(got, boot)

        // The box binds its ML-DSA key; from now on a stripped boot-key binding is refused.
        mailbox.boxPqKeyBindings[f.domain] = try JSONSerialization.data(withJSONObject: f.wire)
        let boot2 = PqBin.hex(PqBytes(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation))
        mailbox.bootKeyBindings[f.domain] = try bootWire(f, bootPub: boot2, issuedAt: 6, hybrid: false)
        got = await BootKey.forServer(username: "alice", serverDomain: f.domain, mailbox: mailbox, pins: pins)
        XCTAssertEqual(got, boot, "stripped binding refused; the earlier pin stands")
        XCTAssertNotNil(pins.pinnedBoxPqKey(username: "alice", serverDomain: f.domain))

        mailbox.bootKeyBindings[f.domain] = try bootWire(f, bootPub: boot2, issuedAt: 6, hybrid: true)
        got = await BootKey.forServer(username: "alice", serverDomain: f.domain, mailbox: mailbox, pins: pins)
        XCTAssertEqual(got, boot2)

        // A changed ML-DSA key refuses the boot key outright.
        var other = f.wire
        other["mldsaPubHex"] = f.otherWire["mldsaPubHex"]
        mailbox.boxPqKeyBindings[f.domain] = try JSONSerialization.data(withJSONObject: other)
        got = await BootKey.forServer(username: "alice", serverDomain: f.domain, mailbox: mailbox, pins: pins)
        XCTAssertNil(got)
    }

    func testBootKeyBindingV2GateVector() throws {
        let v = try vectors()
        let g = (v["gate"] as! [[String: Any]]).first { $0["name"] as? String == "boot-key-binding-v2" }!
        let parts = String(decoding: PqBin.unhex(g["messageHex"] as! String)!, as: UTF8.self).split(separator: "|").map(String.init)
        let stk = (v["bindings"] as! [String: Any])["valid"] as! [[String: Any]]
        let w = stk.first { $0["name"] as? String == "box-stk" }!["wire"] as! [String: Any]
        let sig = (g["envelope"] as! [String: Any])["signature"] as! String
        XCTAssertTrue(BoxKeyPins.verifyBootKeyBindingV2(serverDomain: parts[1], bootPubHex: parts[2], issuedAt: Int64(parts[3])!,
                                                        hybridSignatureHex: sig, stkHex: w["ed25519PubHex"] as! String, mldsaPubHex: w["mldsaPubHex"] as! String))
        XCTAssertFalse(BoxKeyPins.verifyBootKeyBindingV2(serverDomain: parts[1], bootPubHex: parts[2], issuedAt: Int64(parts[3])! + 1,
                                                         hybridSignatureHex: sig, stkHex: w["ed25519PubHex"] as! String, mldsaPubHex: w["mldsaPubHex"] as! String))
        XCTAssertFalse(BoxKeyPins.verifyBootKeyBindingV2(serverDomain: parts[1], bootPubHex: parts[2], issuedAt: Int64(parts[3])!,
                                                         hybridSignatureHex: nil, stkHex: w["ed25519PubHex"] as! String, mldsaPubHex: w["mldsaPubHex"] as! String))
    }
}
