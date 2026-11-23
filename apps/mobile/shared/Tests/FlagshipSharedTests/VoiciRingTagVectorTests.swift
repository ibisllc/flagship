import XCTest
@testable import FlagshipCore

/// Pins the ring tag and locked-name key (VoiciRing.swift, names on a locked phone) to
/// packages/protocol/test-vectors/voici/ring-tag.json (tools/voici-ring-tag-vectors.ts).
final class VoiciRingTagVectorTests: XCTestCase {
    typealias S = VoiciVectorSupport

    func testTagKeyTagsAndLockedNames() throws {
        let v = try S.load("packages/protocol/test-vectors/voici/ring-tag.json", from: #filePath)
        XCTAssertEqual(VoiciRings.tagRingTag, S.s(v["tagRingTag"]))
        XCTAssertEqual(VoiciRings.tagLockedName, S.s(v["tagLockedName"]))
        let key = try VoiciRings.deriveRingTagKey(messagesSecret: S.h(v["messagesSecret"]), pageId: S.s(v["pageId"]))
        XCTAssertEqual(CanonicalJson.hex(key), S.s(v["tagKey"]))
        let other = try VoiciRings.deriveRingTagKey(messagesSecret: S.h(v["messagesSecret"]), pageId: S.s(v["otherPageId"]))
        XCTAssertEqual(CanonicalJson.hex(other), S.s(v["otherTagKey"]))
        for t in S.a(v["tags"]) {
            XCTAssertEqual(VoiciRings.ringTag(tagKey: key, ringId: S.s(t["ringId"])), S.s(t["tag"]))
            XCTAssertTrue(VoiciRings.ringTagMatches(tagKey: key, ringId: S.s(t["ringId"]), tag: S.s(t["tag"])))
            XCTAssertFalse(VoiciRings.ringTagMatches(tagKey: key, ringId: S.s(t["ringId"]), tag: S.s(t["otherPageTag"])))
            XCTAssertFalse(VoiciRings.ringTagMatches(tagKey: other, ringId: S.s(t["ringId"]), tag: S.s(t["tag"])))
        }
        XCTAssertNil(VoiciRings.ringTag(tagKey: key, ringId: "nope"))
        XCTAssertThrowsError(try VoiciRings.deriveRingTagKey(messagesSecret: S.h(v["messagesSecret"]), pageId: "nope"))
        for n in S.a(v["lockedNames"]) {
            XCTAssertEqual(VoiciRings.lockedNameKey(pseudonymPub: S.s(n["pseudonymPub"])), S.s(n["key"]))
        }
    }

    func testAttachCarriesTheKeyOnlyOnAttach() throws {
        let seed = [UInt8](repeating: 0x3c, count: 32), key = [UInt8](repeating: 0x5a, count: 32)
        let pageId = String(repeating: "3f", count: 16), conv = String(repeating: "22", count: 32)
        let attach = try VoiciRings.signedRingBack(pageId: pageId, conv: conv, op: "attach", issuedAt: 5, pseudonymSeed: seed, ringTagKey: key)
        XCTAssertEqual(attach["ringTagKey"]?.string, CanonicalJson.hex(key))
        let stop = try VoiciRings.signedRingBack(pageId: pageId, conv: conv, op: "stop", issuedAt: 5, pseudonymSeed: seed, ringTagKey: key)
        XCTAssertNil(stop["ringTagKey"])
    }

    func testRingPushReadsTheTag() {
        let id = String(repeating: "5c", count: 16), tag = String(repeating: "ab", count: 16)
        XCTAssertEqual(VoiciRingPush.parse(["ringId": id, "hint": "aGludA==", "tag": tag])?.tag, tag)
        XCTAssertNil(VoiciRingPush.parse(["ringId": id, "hint": "aGludA==", "tag": "AB"])?.tag)
        XCTAssertNil(VoiciRingPush.parse(["ringId": id, "hint": "aGludA=="])?.tag)
    }
}
