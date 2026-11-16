import XCTest
@testable import FlagshipCore

/// Pins VoiciRing.swift (the owner's ring back into a conversation, the hint sealed to the caller's thread key) to
/// packages/protocol/test-vectors/voici-call-modes/vectors.json, section `ring` (tools/voici-call-modes-vectors.ts).
final class VoiciRingVectorTests: XCTestCase {
    typealias S = VoiciVectorSupport

    func testRingAndHint() throws {
        let v = try S.load("packages/protocol/test-vectors/voici-call-modes/vectors.json", from: #filePath)
        let r = try XCTUnwrap(v["ring"]), o = try XCTUnwrap(r["order"]), p = try XCTUnwrap(r["hintPlain"])
        XCTAssertEqual(S.text(try VoiciRings.canonicalRing(pageId: S.s(o["pageId"]), conv: S.s(o["conv"]), ringId: S.s(o["ringId"]), hint: S.s(o["hint"]),
                                                            media: S.s(o["media"]), issuedAt: S.i(o["issuedAt"]))), S.s(r["canonical"]))
        for t in S.a(r["checks"]) {
            XCTAssertEqual(VoiciRings.verifyRing(t["ring"]!, signature: S.s(t["signature"]), ownerSignPub: S.s(r["ownerSignPub"])), t["expect"] == .bool(true), S.s(t["name"]))
        }
        let hint = VoiciRingHint(pageId: S.s(p["pageId"]), username: S.s(p["username"]), conv: S.s(p["conv"]), ringId: S.s(p["ringId"]),
                                 media: S.s(p["media"]), issuedAt: S.i(p["issuedAt"]))
        let sealed = try VoiciRings.sealHint(threadPub: S.h(r["threadPub"]), hint, eseed: S.h(r["hintEseed"]))
        XCTAssertEqual(CanonicalJson.b64Encode(sealed), S.s(o["hint"]))
        XCTAssertEqual(VoiciRings.openHint(threadSeed: S.h(r["threadSeed"]), conv: hint.conv, ringId: hint.ringId, sealed: sealed), hint)
        XCTAssertNil(VoiciRings.openHint(threadSeed: S.h(r["threadSeed"]), conv: hint.conv, ringId: String(repeating: "00", count: 16), sealed: sealed))
        XCTAssertNil(VoiciRings.openHint(threadSeed: [UInt8](repeating: 7, count: 32), conv: hint.conv, ringId: hint.ringId, sealed: sealed))
        // The phone's own ring verifies under its owner key (CryptoKit's Ed25519 is randomized, so it is verified, not compared).
        let seed = [UInt8](repeating: 0x2b, count: 32)
        let mine = try VoiciRings.signedRing(pageId: hint.pageId, conv: hint.conv, ringId: hint.ringId, hint: S.s(o["hint"]), media: hint.media,
                                             issuedAt: hint.issuedAt, ownerSignSeed: seed)
        XCTAssertTrue(VoiciRings.verifyRing(mine.ring, signature: mine.signature, ownerSignPub: CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: seed))))
    }

    func testRingBackChannel() throws {
        let v = try S.load("packages/protocol/test-vectors/voici-call-modes/vectors.json", from: #filePath)
        let r = try XCTUnwrap(v["ringBack"]), app = try XCTUnwrap(r["app"]), o = try XCTUnwrap(app["order"])
        let bytes = try VoiciRings.canonicalRingBack(pageId: S.s(o["pageId"]), conv: S.s(o["conv"]), op: S.s(o["op"]), issuedAt: S.i(o["issuedAt"]))
        XCTAssertEqual(S.text(bytes), S.s(r["canonical"]))
        XCTAssertTrue(CanonicalJson.ed25519VerifyHex(S.s(app["sig"]), bytes, S.s(app["from"])))
        XCTAssertThrowsError(try VoiciRings.canonicalRingBack(pageId: S.s(o["pageId"]), conv: S.s(o["conv"]), op: "pause", issuedAt: 1))
        let seed = [UInt8](repeating: 0x3c, count: 32)
        let mine = try VoiciRings.signedRingBack(pageId: S.s(o["pageId"]), conv: S.s(o["conv"]), op: "attach", issuedAt: 5, pseudonymSeed: seed)
        XCTAssertEqual(Set(mine.object!.keys), ["order", "signer", "from", "sig"])
        XCTAssertTrue(CanonicalJson.ed25519VerifyHex(S.s(mine["sig"]), try VoiciRings.canonicalRingBack(pageId: S.s(o["pageId"]), conv: S.s(o["conv"]), op: "attach", issuedAt: 5),
                                                     S.s(mine["from"])))
    }
}
