import XCTest
@testable import FlagshipCore

/// Pins VoiciCallModes.swift (anonymous calls and their proof of work) and VoiciConversation.swift (delete, reveal) to
/// packages/protocol/test-vectors/voici-call-modes/ and voici-conversation/. CryptoKit's Ed25519 is randomized, so the
/// phone's own signatures are verified, never compared.
final class VoiciCallModesVectorTests: XCTestCase {
    typealias S = VoiciVectorSupport

    func testAnonymousRequestAndWork() throws {
        let v = try S.load("packages/protocol/test-vectors/voici-call-modes/vectors.json", from: #filePath)
        let p = try XCTUnwrap(v["pow"]), a = try XCTUnwrap(v["anon"]), ctx = try XCTUnwrap(a["ctx"])
        XCTAssertTrue(VoiciCallModes.powSolves(challenge: S.s(p["challenge"]), nonce: S.s(p["nonce"])))
        XCTAssertFalse(VoiciCallModes.powSolves(challenge: S.s(p["challenge"]), nonce: S.s(p["wrongNonce"])))
        XCTAssertEqual(VoiciCallModes.parsePow(S.s(p["challenge"]))?.bits, Int(S.i(p["bits"])))
        let signed = try XCTUnwrap(a["signed"])
        XCTAssertEqual(S.text(try XCTUnwrap(VoiciCallModes.requestAnonBytes(signed))), S.s(a["canonical"]))
        // The answering phone hashes an anonymous request by its own kind.
        XCTAssertEqual(VoiciCalls.requestHash(signed), S.s(a["hash"]))
        let check = { (input: JSONValue, from: String) in
            VoiciCallModes.checkRequestAnon(input, pageId: S.s(ctx["pageId"]), acceptsCalls: ctx["acceptsCalls"] == .bool(true), callsFrom: from, now: S.i(ctx["now"])).code
        }
        for t in S.a(a["checks"]) { XCTAssertEqual(check(t["input"]!, S.s(ctx["callsFrom"])), S.s(t["expect"]), S.s(t["name"])) }
        for t in S.a(a["modeChecks"]) { XCTAssertEqual(check(signed, S.s(t["callsFrom"])), S.s(t["expect"]), S.s(t["name"])) }
        let r = try XCTUnwrap(VoiciCallModes.checkRequestAnon(signed, pageId: S.s(ctx["pageId"]), acceptsCalls: true, callsFrom: "anyone", now: S.i(ctx["now"])).value)
        XCTAssertEqual(r.delegatePub, S.s(a["browserPub"]))
        XCTAssertEqual(VoiciCallModes.anonConv(pageId: r.pageId, browserPub: r.delegatePub), r.conv)
    }

    func testDeleteAndReveal() throws {
        let v = try S.load("packages/protocol/test-vectors/voici-conversation/vectors.json", from: #filePath)
        let d = try XCTUnwrap(v["delete"]), o = try XCTUnwrap(d["owner"]), app = try XCTUnwrap(d["app"])
        let bytes = try VoiciConversations.canonicalDelete(pageId: S.s(o["del"]?["pageId"]), conv: S.s(o["del"]?["conv"]), side: "owner", issuedAt: S.i(o["del"]?["issuedAt"]))
        XCTAssertEqual(S.text(bytes), S.s(d["canonical"]))
        XCTAssertTrue(CanonicalJson.ed25519VerifyHex(S.s(o["sig"]), bytes, S.s(v["ownerSignPub"])))
        let callerBytes = try VoiciConversations.canonicalDelete(pageId: S.s(app["del"]?["pageId"]), conv: S.s(app["del"]?["conv"]), side: "caller",
                                                                 issuedAt: S.i(app["del"]?["issuedAt"]))
        XCTAssertTrue(CanonicalJson.ed25519VerifyHex(S.s(app["sig"]), callerBytes, S.s(app["from"])))
        XCTAssertThrowsError(try VoiciConversations.canonicalDelete(pageId: S.s(v["pageId"]), conv: S.s(v["conv"]).uppercased(), side: "owner", issuedAt: 1))
        let seed = [UInt8](repeating: 0x4d, count: 32), pub = CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: seed))
        let mineOwner = try VoiciConversations.signedDeleteOwner(pageId: S.s(v["pageId"]), conv: S.s(v["conv"]), issuedAt: 9, ownerSignSeed: seed)
        XCTAssertEqual(Set(mineOwner.object!.keys), ["del", "signer", "sig"])
        XCTAssertTrue(CanonicalJson.ed25519VerifyHex(S.s(mineOwner["sig"]), try VoiciConversations.canonicalDelete(pageId: S.s(v["pageId"]), conv: S.s(v["conv"]), side: "owner", issuedAt: 9), pub))
        let mineCaller = try VoiciConversations.signedDeleteCaller(pageId: S.s(v["pageId"]), conv: S.s(v["conv"]), issuedAt: 9, pseudonymSeed: seed)
        XCTAssertEqual(S.s(mineCaller["from"]), pub)
        XCTAssertEqual(mineCaller["del"]?["side"]?.string, "caller")

        let r = try XCTUnwrap(v["reveal"]), rctx = try XCTUnwrap(r["ctx"])
        let signed = try XCTUnwrap(r["signed"])
        XCTAssertEqual(S.text(try VoiciConversations.canonicalReveal(conv: S.s(signed["conv"]), username: S.s(signed["username"]),
                                                                    displayName: signed["displayName"]?.string, issuedAt: S.i(signed["issuedAt"]))), S.s(r["canonical"]))
        XCTAssertEqual(VoiciConversations.revealNameHash(signed["displayName"]?.string), S.s(r["nameHash"]))
        for t in S.a(r["checks"]) {
            XCTAssertEqual(VoiciConversations.checkReveal(t["input"], conv: S.s(rctx["conv"]), pageSignPub: S.s(rctx["pageSignPub"])).code, S.s(t["expect"]), S.s(t["name"]))
        }
        let ok = try XCTUnwrap(VoiciConversations.checkReveal(signed, conv: S.s(rctx["conv"]), pageSignPub: S.s(rctx["pageSignPub"])).value)
        XCTAssertEqual(VoiciConversations.pillText(ok), "Bob Rivera (bob)")
        let noName = try XCTUnwrap(VoiciConversations.checkReveal(r["noName"], conv: S.s(rctx["conv"]), pageSignPub: S.s(rctx["pageSignPub"])).value)
        XCTAssertEqual(VoiciConversations.pillText(noName), "bob")
        let mine = try VoiciConversations.signedReveal(conv: S.s(rctx["conv"]), username: "bob", displayName: "Bob Rivera", issuedAt: 5, pageSignSeed: S.h(r["pageSignSeed"]))
        XCTAssertEqual(VoiciConversations.checkReveal(mine, conv: S.s(rctx["conv"]), pageSignPub: S.s(rctx["pageSignPub"])).code, "ok")
        XCTAssertEqual(VoiciConversations.parseControl(r["unreveal"]), .unreveal(conv: S.s(rctx["conv"]), issuedAt: S.i(r["unreveal"]?["issuedAt"])))
        for t in S.a(r["unrevealShapes"]) { XCTAssertEqual(VoiciConversations.parseControl(t["input"]) != nil, t["expect"] == .bool(true), S.s(t["name"])) }
        XCTAssertEqual(VoiciConversations.controlBody(mine)["control"], mine)
    }

    func testAnonBlockAndControlBodies() throws {
        let v = try S.load("packages/protocol/test-vectors/voici-conversation/vectors.json", from: #filePath)
        let b = try XCTUnwrap(v["anonBlock"]), o = try XCTUnwrap(b["order"])
        XCTAssertEqual(S.text(try VoiciConversations.canonicalAnonBlock(pageId: S.s(o["pageId"]), conv: S.s(o["conv"]), op: S.s(o["op"]), issuedAt: S.i(o["issuedAt"]))),
                       S.s(b["canonical"]))
        for t in S.a(b["checks"]) {
            XCTAssertEqual(VoiciConversations.verifyAnonBlock(t["block"], signature: S.s(t["signature"]), ownerSignPub: S.s(v["ownerSignPub"])), t["expect"] == .bool(true), S.s(t["name"]))
        }
        for t in S.a(b["shapes"]) {
            let i = t["input"]!
            let ok = (try? VoiciConversations.canonicalAnonBlock(pageId: i["pageId"]?.string ?? "", conv: i["conv"]?.string ?? "", op: i["op"]?.string ?? "",
                                                                 issuedAt: i["issuedAt"]?.time ?? -1)) != nil && Set(i.object!.keys) == ["pageId", "conv", "op", "issuedAt"]
            XCTAssertEqual(ok, t["expect"] == .bool(true), S.s(t["name"]))
        }
        // The owner deletes an anonymous conversation (16 bytes) too.
        let od = try XCTUnwrap(b["ownerDelete"])
        XCTAssertTrue(CanonicalJson.ed25519VerifyHex(S.s(od["sig"]), try VoiciConversations.canonicalDelete(pageId: S.s(od["del"]?["pageId"]), conv: S.s(od["del"]?["conv"]),
                                                                                                        side: "owner", issuedAt: S.i(od["del"]?["issuedAt"])), S.s(v["ownerSignPub"])))
        // A reveal or an unreveal travels as a {v:1, control} body; the owner's inbox key opens it, for its conversation only.
        let c = try XCTUnwrap(v["control"]), conv = S.s(v["conv"]), seed = S.h(c["inboxSeed"])
        for name in ["reveal", "unreveal"] {
            let x = try XCTUnwrap(c[name])
            let got = VoiciMessages.openVoiciControl(Array(try XCTUnwrap(Data(base64Encoded: S.s(x["body"])))), conv: conv, msgId: S.s(x["msgId"]), recipientSeed: seed)
            XCTAssertEqual(got, VoiciConversations.parseControl(x["control"]), name)
            XCTAssertNotNil(got, name)
        }
        let w = try XCTUnwrap(c["wrongConv"])
        XCTAssertNil(VoiciMessages.openVoiciControl(Array(try XCTUnwrap(Data(base64Encoded: S.s(w["body"])))), conv: conv, msgId: S.s(w["msgId"]), recipientSeed: seed))
        // The phone's own control body opens the same way.
        let inboxPub = try PqHybrid.hybridSealKeygen(seed: seed).publicKey
        let mine = try VoiciMessages.sealVoiciControl(conv: conv, msgId: String(repeating: "b2", count: 16), sentAt: 5, fromPub: String(repeating: "ab", count: 32),
                                                      recipients: [inboxPub, inboxPub], control: VoiciConversations.unreveal(conv: conv, issuedAt: 5))
        XCTAssertEqual(VoiciMessages.openVoiciControl(mine, conv: conv, msgId: String(repeating: "b2", count: 16), recipientSeed: seed), .unreveal(conv: conv, issuedAt: 5))
    }

    func testCallHours() throws {
        let v = try S.load("packages/protocol/test-vectors/voici-call-modes/vectors.json", from: #filePath)
        let h = try XCTUnwrap(v["callHours"])
        for t in S.a(h["shapes"]) {
            let value = try XCTUnwrap(t["value"]?.string), name = t["name"]?.string ?? "?"
            XCTAssertEqual(VoiciPage.isCallHours(value), t["expect"] == .bool(true), name)
        }
        for t in S.a(h["open"]) {
            let hours = t["hours"]?.string, now = try XCTUnwrap(t["now"]?.safeInt ?? t["now"]?.time)
            XCTAssertEqual(VoiciPage.callHoursOpen(hours, now: now), t["expect"] == .bool(true), t["name"]?.string ?? "?")
        }
        for t in S.a(h["index"]) { XCTAssertEqual(VoiciPage.parseVoiciPageIndex(try XCTUnwrap(t["index"])) != nil, t["ok"] == .bool(true), t["name"]?.string ?? "?") }
        let with = try XCTUnwrap(VoiciPage.parseVoiciPageIndex(try XCTUnwrap(h["withHours"])))
        XCTAssertEqual(S.text(try VoiciPage.canonicalVoiciPageIndex(with)), try XCTUnwrap(h["withHoursCanonical"]?.string))
        XCTAssertEqual(with.json, h["withHours"])
        let without = try XCTUnwrap(VoiciPage.parseVoiciPageIndex(try XCTUnwrap(h["noHours"])))
        XCTAssertEqual(S.text(try VoiciPage.canonicalVoiciPageIndex(without)), try XCTUnwrap(h["noHoursCanonical"]?.string))
    }
}
