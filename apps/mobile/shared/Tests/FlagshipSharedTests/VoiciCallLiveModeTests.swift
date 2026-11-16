import XCTest
@testable import FlagshipCore

/// An anonymous call the browser built (packages/protocol/test-vectors/voici-call-modes/browser-built.json) and the
/// answering phone's call mode: its own copy of the index can be older than the page `.com` rang for (the mode was
/// changed on another device, or the phone is locked and keeps no copy), so a mode refusal is checked once more
/// against the live signed index. The 2026-11-16 gym iPhone rejected an anonymous call this way within a second.
final class VoiciCallLiveModeTests: XCTestCase {
    typealias S = VoiciVectorSupport
    private let admin = [UInt8](repeating: 0x41, count: 32)

    private func browserBuilt() throws -> (ctx: JSONValue, requests: [String: JSONValue]) {
        let v = try S.load("packages/protocol/test-vectors/voici-call-modes/browser-built.json", from: #filePath)
        return (try XCTUnwrap(v["ctx"]), try XCTUnwrap(v["requests"]?.object))
    }

    func testTheBrowsersAnonymousRequestsCheckHere() throws {
        let (ctx, requests) = try browserBuilt()
        XCTAssertEqual(Set(requests.keys), ["audio", "video"])
        for (kind, r) in requests {
            let check = { (on: Bool, from: String) in
                VoiciCallModes.checkRequestAnon(r, pageId: S.s(ctx["pageId"]), acceptsCalls: on, callsFrom: from, now: S.i(ctx["now"])).code
            }
            XCTAssertEqual(check(true, "anyone"), "ok", kind)
            for from in ["accepted", "signed-in", "callback"] { XCTAssertEqual(check(true, from), "not-allowed", "\(kind) \(from)") }
            XCTAssertEqual(check(false, "anyone"), "calls-off", kind)
        }
        XCTAssertEqual(VoiciCallModes.checkRequestAnon(requests["video"]!, pageId: S.s(ctx["pageId"]), acceptsCalls: true, callsFrom: "anyone",
                                                       now: S.i(ctx["now"])).value?.media, VoiciCalls.mediaVideo)
    }

    func testAModeRefusalAsksTheLiveIndexOnce() async throws {
        let (ctx, requests) = try browserBuilt()
        let r = try XCTUnwrap(requests["audio"]), pageId = S.s(ctx["pageId"]), now = S.i(ctx["now"])
        var asked = 0
        // The copy says signed-in, the page `.com` rang for says anyone: the live index decides.
        var v = await VoiciCallModes.checkRequestAnon(r, pageId: pageId, mode: (true, "signed-in"), now: now, live: { asked += 1; return (true, "anyone") })
        XCTAssertEqual(v.code, "ok")
        XCTAssertEqual(asked, 1)
        // A locked phone keeps no copy.
        v = await VoiciCallModes.checkRequestAnon(r, pageId: pageId, mode: (true, "accepted"), now: now, live: { (true, "anyone") })
        XCTAssertEqual(v.code, "ok")
        v = await VoiciCallModes.checkRequestAnon(r, pageId: pageId, mode: (false, "accepted"), now: now, live: { (true, "anyone") })
        XCTAssertEqual(v.code, "ok")
        // The live index refuses too, or can't be read: the refusal stands.
        v = await VoiciCallModes.checkRequestAnon(r, pageId: pageId, mode: (true, "signed-in"), now: now, live: { (true, "callback") })
        XCTAssertEqual(v.code, "not-allowed")
        v = await VoiciCallModes.checkRequestAnon(r, pageId: pageId, mode: (true, "signed-in"), now: now, live: { nil })
        XCTAssertEqual(v.code, "not-allowed")
        // Any other refusal never fetches.
        asked = 0
        v = await VoiciCallModes.checkRequestAnon(r, pageId: String(repeating: "00", count: 16), mode: (true, "signed-in"), now: now,
                                                  live: { asked += 1; return (true, "anyone") })
        XCTAssertEqual(v.code, "wrong-audience")
        v = await VoiciCallModes.checkRequestAnon(r, pageId: pageId, mode: (true, "anyone"), now: now + 3_600_000, live: { asked += 1; return (true, "anyone") })
        XCTAssertEqual(v.code, "stale")
        XCTAssertEqual(asked, 0)
    }

    private func signedIndex(pageId: String, seq: Int64, on: Bool, from: String) throws -> JSONValue {
        let fields = on ? (Int64(1), from) : (nil, nil) as (Int64?, String?)
        let body = VoiciPageIndex(username: "ana", pageId: pageId, seq: seq, issuedAt: 1_800_000_000_000, acceptsMessages: 1, inboxEpoch: 1,
                                  inboxPub: String(repeating: "22", count: PqHybrid.sealPublicKeyLen), ownerSignPub: String(repeating: "33", count: 32),
                                  pieces: [VoiciPieceRef(role: "profile", sha256: String(repeating: "55", count: 32), size: 10)], signerKind: "admin-root", acceptsCalls: fields.0, callsFrom: fields.1)
        return try VoiciPage.signVoiciPageIndex(body, signerSeed: admin).json
    }

    func testTheLiveModeComesFromTheAccountsSignedIndexOnly() async throws {
        let pageId = String(repeating: "a1", count: 16)
        let m = MockVoiciComClient()
        m.keys["ana"] = VoiciAccountKeys(irkPub: String(repeating: "11", count: 32), adminRootPub: CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: admin)))
        m.pages["ana"] = try signedIndex(pageId: pageId, seq: 7, on: true, from: "anyone")
        let live = await VoiciCallModes.liveCallMode(client: m, username: "ana", pageId: pageId, highestSeenSeq: 6)
        XCTAssertEqual(live?.mode.acceptsCalls, true)
        XCTAssertEqual(live?.mode.callsFrom, "anyone")
        XCTAssertEqual(live?.index.seq, 7)
        // Older than this device saw, another page, or not the account's key: nothing.
        let rolledBack = await VoiciCallModes.liveCallMode(client: m, username: "ana", pageId: pageId, highestSeenSeq: 8)
        XCTAssertNil(rolledBack)
        let otherPage = await VoiciCallModes.liveCallMode(client: m, username: "ana", pageId: String(repeating: "b2", count: 16))
        XCTAssertNil(otherPage)
        m.keys["ana"] = VoiciAccountKeys(irkPub: String(repeating: "11", count: 32), adminRootPub: String(repeating: "44", count: 32))
        let wrongKey = await VoiciCallModes.liveCallMode(client: m, username: "ana", pageId: pageId)
        XCTAssertNil(wrongKey)
        // Calls off in the live index.
        m.keys["ana"] = VoiciAccountKeys(irkPub: String(repeating: "11", count: 32), adminRootPub: CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: admin)))
        m.pages["ana"] = try signedIndex(pageId: pageId, seq: 9, on: false, from: "")
        let off = await VoiciCallModes.liveCallMode(client: m, username: "ana", pageId: pageId)
        XCTAssertEqual(off?.mode.acceptsCalls, false)
    }
}
