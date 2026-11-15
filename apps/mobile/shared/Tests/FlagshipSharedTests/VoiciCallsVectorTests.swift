import XCTest
@testable import FlagshipCore

/// Pins VoiciCalls.swift to packages/protocol/test-vectors/voici-calls/vectors.json (tools/voici-calls-vectors.ts; the
/// TS replay is packages/protocol/tests/voiciCallsVectors.test.ts). CryptoKit's Ed25519 signatures are randomized, so
/// the phone's own answers and end orders are verified, never compared; everything else matches byte for byte.
final class VoiciCallsVectorTests: XCTestCase {
    typealias S = VoiciVectorSupport

    private func vectors() throws -> JSONValue {
        try S.load("packages/protocol/test-vectors/voici-calls/vectors.json", from: #filePath)
    }

    private func set(_ v: JSONValue?) -> Set<String>? { v?.array.map { Set($0.compactMap(\.string)) } }

    func testConstantsAndSdp() throws {
        let v = try vectors(), c = try XCTUnwrap(v["constants"])
        XCTAssertEqual(S.i(c["sealedFrame"]), Int64(VoiciCalls.sealedFrame))
        XCTAssertEqual(S.i(c["framesPerEpoch"]), Int64(VoiciCalls.framesPerEpoch))
        XCTAssertEqual(S.i(c["replayWindow"]), Int64(VoiciCalls.replayWindow))
        XCTAssertEqual(S.i(c["maxGapFrames"]), Int64(VoiciCalls.maxGapFrames))
        XCTAssertEqual(S.i(c["receiptTtlMs"]), VoiciCalls.receiptTtlMs)
        XCTAssertEqual(S.i(c["maxCallMs"]), VoiciCalls.maxCallMs)
        let sdp = try XCTUnwrap(v["sdp"])
        XCTAssertEqual(VoiciCalls.mungeSdp(S.s(sdp["offerRaw"])), S.s(sdp["offer"]))
        XCTAssertEqual(VoiciCalls.mungeSdp(S.s(sdp["answerRaw"])), S.s(sdp["answer"]))
        XCTAssertEqual(VoiciCalls.mungeSdp(S.s(sdp["offer"])), S.s(sdp["offer"]))
        XCTAssertEqual(VoiciCalls.sdpFingerprint(S.s(sdp["offer"])), S.s(sdp["offerFingerprint"]))
        for t in S.a(sdp["checks"]) { XCTAssertEqual(VoiciCalls.checkSdp(S.s(t["sdp"])), S.optS(t["expected"]), S.s(t["name"])) }
    }

    func testRequest() throws {
        let r = try XCTUnwrap(try vectors()["request"])
        let signed = try XCTUnwrap(r["signed"])
        XCTAssertEqual(VoiciCalls.requestHash(signed), S.s(r["hash"]))
        let bytes = try VoiciCalls.canonicalRequest(pageId: S.s(signed["pageId"]), conv: S.s(signed["conv"]), callId: S.s(signed["callId"]),
                                                    callerXwingPub: S.s(signed["callerXwingPub"]), offerSdp: S.s(signed["offerSdp"]), issuedAt: S.i(signed["issuedAt"]))
        XCTAssertEqual(S.text(bytes), S.s(r["canonical"]))
        for t in S.a(r["checks"]) {
            let c = try XCTUnwrap(t["ctx"])
            let ctx = VoiciCallRequestCheckContext(
                pageId: S.s(c["pageId"]), acceptsCalls: c["acceptsCalls"] == .bool(true), origin: S.s(c["origin"]),
                caKeys: S.a(c["caKeys"]).map { $0.string! }, now: S.i(c["now"]), blocked: set(c["blocked"]), revoked: set(c["revoked"]),
                allowed: c["notAllowed"] == .bool(true) ? { _ in false } : nil, skipFresh: c["skipFresh"] == .bool(true))
            XCTAssertEqual(VoiciCalls.checkRequest(t["request"]!, ctx).code, S.s(t["expected"]), S.s(t["name"]))
        }
    }

    func testKeysAnswerFrames() throws {
        let v = try vectors(), k = try XCTUnwrap(v["keys"]), request = try XCTUnwrap(v["request"]?["signed"])
        let e = try VoiciCalls.encapsulate(callerXwingPub: S.h(k["callerXwingPub"]), eseed: S.h(k["eseed"]))
        XCTAssertEqual(CanonicalJson.hex(e.ciphertext), S.s(k["xwingCiphertext"]))
        XCTAssertEqual(CanonicalJson.hex(e.sharedSecret), S.s(k["sharedSecret"]))
        XCTAssertEqual(CanonicalJson.hex(try VoiciCalls.decapsulate(ciphertext: S.h(k["xwingCiphertext"]), callerSeed: S.h(k["callerSeed"]))), S.s(k["sharedSecret"]))
        XCTAssertEqual(try VoiciCalls.deviceRef(devicePubHex: S.s(k["devicePub"])), S.s(k["deviceRef"]))

        let a = try XCTUnwrap(v["answer"]), body = try XCTUnwrap(VoiciCalls.parseAnswer(a["signed"])).body
        let answerBytes = try VoiciCalls.canonicalAnswer(body)
        XCTAssertEqual(S.text(answerBytes), S.s(a["canonical"]))
        let mine = try VoiciCalls.signAnswer(body, ownerSignSeed: S.h(k["ownerSignSeed"]))
        XCTAssertEqual(VoiciCalls.checkAnswer(mine, request: request, ownerSignPub: S.s(k["ownerSignPub"])).code, "ok")
        for t in S.a(a["checks"]) {
            let c = try XCTUnwrap(t["ctx"])
            XCTAssertEqual(VoiciCalls.checkAnswer(t["answer"]!, request: request, ownerSignPub: S.s(c["ownerSignPub"]), now: c["now"]?.safeInt).code,
                           S.s(t["expected"]), S.s(t["name"]))
        }

        let f = try XCTUnwrap(v["frames"])
        let reqBytes = try VoiciCalls.canonicalRequest(pageId: S.s(request["pageId"]), conv: S.s(request["conv"]), callId: S.s(request["callId"]),
                                                       callerXwingPub: S.s(request["callerXwingPub"]), offerSdp: S.s(request["offerSdp"]), issuedAt: S.i(request["issuedAt"]))
        let fk = VoiciCalls.frameKeys(sharedSecret: S.h(k["sharedSecret"]), requestBytes: reqBytes, answerBytes: answerBytes)
        XCTAssertEqual(CanonicalJson.hex(fk.c2p), S.s(f["c2p"]))
        XCTAssertEqual(CanonicalJson.hex(fk.p2c), S.s(f["p2c"]))
        XCTAssertEqual(CanonicalJson.hex(VoiciCalls.nextFrameKey(fk.c2p)), S.s(f["c2pEpoch1"]))
        let callId = S.s(request["callId"])
        for t in S.a(f["cases"]) {
            let dir = VoiciCallDir(rawValue: S.s(t["dir"]))!, ctr = UInt64(S.i(t["ctr"]))
            XCTAssertEqual(CanonicalJson.hex(try VoiciCalls.sealFrame(key: S.h(t["key"]), callId: callId, dir: dir, ctr: ctr, frame: S.h(t["frame"]))), S.s(t["sealed"]))
            XCTAssertEqual(VoiciCalls.epoch(ctr), UInt64(S.i(t["epoch"])))
        }
        for t in S.a(f["refusals"]) {
            XCTAssertNil(VoiciCalls.openFrame(key: S.h(t["key"]), callId: S.s(t["callId"]), dir: VoiciCallDir(rawValue: S.s(t["dir"]))!, sealed: S.h(t["sealed"])), S.s(t["name"]))
        }
        XCTAssertThrowsError(try VoiciCalls.sealFrame(key: fk.c2p, callId: callId, dir: .c2p, ctr: 0, frame: [UInt8](repeating: 0, count: 64)))

        let rx = VoiciCallFrameReceiver(baseKey: S.h(f["c2p"]), callId: callId, dir: .c2p)
        for t in S.a(f["receiver"]) { XCTAssertEqual(rx.open(S.h(t["sealed"])).map(CanonicalJson.hex), S.optS(t["frame"]), S.s(t["note"])) }
        let rx2 = VoiciCallFrameReceiver(baseKey: S.h(f["c2p"]), callId: callId, dir: .c2p)
        for t in S.a(f["epochPrelude"]) + S.a(f["epochRun"]) { XCTAssertEqual(rx2.open(S.h(t["sealed"])).map(CanonicalJson.hex), S.optS(t["frame"])) }
        let tx = VoiciCallFrameSender(baseKey: S.h(f["p2c"]), callId: callId, dir: .p2c)
        let rxp = VoiciCallFrameReceiver(baseKey: S.h(f["p2c"]), callId: callId, dir: .p2c)
        XCTAssertEqual(rxp.open(try tx.seal([1, 2, 3])), [1, 2, 3])
    }

    func testReceiptEndAllowPushMissed() throws {
        let v = try vectors(), k = try XCTUnwrap(v["keys"])
        let rc = try XCTUnwrap(v["receipt"])
        for t in S.a(rc["checks"]) {
            let c = try XCTUnwrap(t["ctx"])
            XCTAssertEqual(VoiciCalls.checkReceipt(t["receipt"], caKeys: S.a(c["caKeys"]).map { $0.string! }, now: S.i(c["now"]),
                                                   account: S.s(c["account"]), deviceRef: c["deviceRef"]?.string).code, S.s(t["expected"]), S.s(t["name"]))
        }
        let end = try XCTUnwrap(v["end"])
        for t in S.a(end["checks"]) {
            let c = try XCTUnwrap(t["ctx"])
            XCTAssertEqual(VoiciCalls.checkEnd(t["end"], callId: S.s(c["callId"]), callerPub: S.s(c["callerPub"]), ownerSignPub: S.s(c["ownerSignPub"])) != nil,
                           t["expected"] == .bool(true), S.s(t["name"]))
        }
        let callId = S.s(v["request"]?["signed"]?["callId"])
        let mine = try VoiciCalls.signEndOwner(callId: callId, reason: "hangup", issuedAt: 1, ownerSignSeed: S.h(k["ownerSignSeed"]))
        XCTAssertEqual(VoiciCalls.checkEnd(mine, callId: callId, callerPub: S.s(k["browserPub"]), ownerSignPub: S.s(k["ownerSignPub"])), "hangup")

        let al = try XCTUnwrap(v["allow"]), o = try XCTUnwrap(al["order"])
        let allowBytes = try VoiciCalls.canonicalAllow(pageId: S.s(o["pageId"]), conv: S.s(o["conv"]), op: S.s(o["op"]), issuedAt: S.i(o["issuedAt"]))
        XCTAssertEqual(S.text(allowBytes), S.s(al["canonical"]))
        XCTAssertTrue(CanonicalJson.ed25519VerifyHex(S.s(al["signature"]), allowBytes, S.s(k["ownerSignPub"])))

        let inbox = S.h(k["inboxSeed"])
        let push = try XCTUnwrap(VoiciCalls.openPush(inboxSeed: inbox, callId: callId, sealed: XCTUnwrap(CanonicalJson.b64Decode(S.s(v["push"]?["sealed"])))))
        XCTAssertEqual(push.from, S.s(k["pseudonymPub"]))
        XCTAssertEqual(push.conv, S.s(k["conv"]))
        XCTAssertNil(VoiciCalls.openPush(inboxSeed: inbox, callId: callId, sealed: try XCTUnwrap(CanonicalJson.b64Decode(S.s(v["push"]?["badConvSealed"])))))
        XCTAssertNil(VoiciCalls.openPush(inboxSeed: inbox, callId: String(repeating: "00", count: 16), sealed: try XCTUnwrap(CanonicalJson.b64Decode(S.s(v["push"]?["sealed"])))))

        let mc = try XCTUnwrap(v["missedCall"]), origin = S.s(v["constants"]?["origin"])
        let missed = VoiciCalls.openMissedCall(inboxSeed: inbox, callId: callId, sealed: try XCTUnwrap(CanonicalJson.b64Decode(S.s(mc["sealed"]))),
                                               pageId: S.s(k["pageId"]), origin: origin, caKeys: [S.s(k["caPub"])])
        XCTAssertEqual(missed?.reason, "no-answer")
        XCTAssertEqual(missed?.request.from, S.s(k["pseudonymPub"]))
        XCTAssertNil(VoiciCalls.openMissedCall(inboxSeed: inbox, callId: callId, sealed: try XCTUnwrap(CanonicalJson.b64Decode(S.s(mc["forgedSealed"]))),
                                               pageId: S.s(k["pageId"]), origin: origin, caKeys: [S.s(k["caPub"])]))
    }

    func testPageIndexV2() throws {
        let p = try XCTUnwrap(try vectors()["pageV2"]), ctx = try XCTUnwrap(p["ctx"])
        let idx = try XCTUnwrap(VoiciPage.parseVoiciPageIndex(p["signed"]!))
        XCTAssertEqual(S.text(try VoiciPage.canonicalVoiciPageIndex(idx)), S.s(p["canonical"]))
        XCTAssertTrue(idx.takesCalls)
        XCTAssertEqual(idx.json, p["signed"]!)
        let resigned = try VoiciPage.signVoiciPageIndex(idx, signerSeed: [UInt8](repeating: 0x33, count: 32))
        XCTAssertEqual(VoiciPage.checkVoiciPageIndex(resigned.json, username: S.s(ctx["username"]), sensitiveKind: S.s(ctx["sensitiveKind"]),
                                                     sensitivePub: S.s(ctx["sensitivePub"])).code, "ok")
        for t in S.a(p["checks"]) {
            XCTAssertEqual(VoiciPage.checkVoiciPageIndex(t["index"]!, username: S.s(ctx["username"]), sensitiveKind: S.s(ctx["sensitiveKind"]),
                                                         sensitivePub: S.s(ctx["sensitivePub"])).code, S.s(t["expected"]), S.s(t["name"]))
        }
    }
}
