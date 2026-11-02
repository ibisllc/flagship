import XCTest
@testable import FlagshipCore

/// Pins the Swift Messages port (CanonicalJson, WebEnvelope, WebDelegation, MessagesAttestation, VoiciMessages,
/// VoiciMessagesRecords, VoiciPhoneWeb) to packages/protocol/test-vectors/messages/vectors.json
/// (tools/voici-vectors.ts; the TS replay is packages/protocol/tests/voiciVectors.test.ts). CryptoKit's Ed25519
/// signatures are randomized and the vectors' P-256 ones are RFC 6979, so signatures are verified, never compared;
/// everything else must match byte for byte. Not replayed: the abuse-tag sealing / abuse key list (not part of the
/// app's port). `threadFetch` is replayed for its canonical bytes only: the app uses it for reply alerts.
final class MessagesVectorTests: XCTestCase {
    typealias S = VoiciVectorSupport

    private func vectors() throws -> JSONValue {
        try S.load("packages/protocol/test-vectors/messages/vectors.json", from: #filePath)
    }

    func testDerivations() throws {
        let d = try XCTUnwrap(try vectors()["derivations"])
        let owner = S.h(d["ownerUmk"]), visitor = S.h(d["visitorUmk"]), pageId = S.s(d["pageId"])
        let inbox = try VoiciMessages.deriveVoiciInboxKey(umk: owner, pageId: pageId, inboxEpoch: S.i(d["inboxEpoch"]))
        XCTAssertEqual(CanonicalJson.hex(inbox.seed), S.s(d["inboxSeed"]))
        XCTAssertEqual(CanonicalJson.hex(inbox.publicKey), S.s(d["inboxPub"]))
        XCTAssertEqual(CanonicalJson.sha256Hex(inbox.publicKey), S.s(d["inboxPubSha256"]))
        XCTAssertEqual(CanonicalJson.hex(try VoiciMessages.deriveVoiciInboxKey(umk: owner, pageId: pageId, inboxEpoch: 2).seed), S.s(d["inboxEpoch2Seed"]))
        let os = try VoiciMessages.deriveVoiciOwnerSignKey(umk: owner, pageId: pageId, inboxEpoch: 1)
        XCTAssertEqual([CanonicalJson.hex(os.seed), CanonicalJson.hex(os.publicKey)], [S.s(d["ownerSignSeed"]), S.s(d["ownerSignPub"])])
        let ms = VoiciMessages.deriveMessagesSecret(umk: visitor)
        XCTAssertEqual(CanonicalJson.hex(ms), S.s(d["messagesSecret"]))
        let p = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: ms, pageId: pageId)
        XCTAssertEqual([CanonicalJson.hex(p.seed), CanonicalJson.hex(p.publicKey)], [S.s(d["pseudonymSeed"]), S.s(d["pseudonymPub"])])
        XCTAssertEqual(CanonicalJson.hex(try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: ms, pageId: String(repeating: "aa", count: 16)).publicKey),
                       S.s(d["otherPagePseudonymPub"]))
        let t = try VoiciMessages.deriveMessagesThreadKey(messagesSecret: ms, pageId: pageId)
        XCTAssertEqual([CanonicalJson.hex(t.seed), CanonicalJson.hex(t.publicKey)], [S.s(d["threadSeed"]), S.s(d["threadPub"])])
        XCTAssertEqual(CanonicalJson.sha256Hex(t.publicKey), S.s(d["threadPubSha256"]))
        XCTAssertEqual(CanonicalJson.hex(VoiciMessages.deriveVoiciDraftsKey(umk: owner)), S.s(d["draftsKey"]))
        XCTAssertEqual(CanonicalJson.hex(VoiciMessages.deriveMessagesStateKey(umk: owner)), S.s(d["stateKey"]))
        XCTAssertEqual(try VoiciMessages.voiciConv(pageId: pageId, pseudonymPub: S.s(d["pseudonymPub"])), S.s(d["conv"]))
        XCTAssertEqual(try VoiciText.voiciPseudonymName(S.s(d["pseudonymPub"])), S.s(d["pseudonymName"]))
        XCTAssertThrowsError(try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: ms, pageId: "XX"))
    }

    func testCanonicalJsonAndBase64() throws {
        let v = try vectors()
        for c in S.a(v["canonicalJson"]?["cases"]) {
            XCTAssertEqual(try CanonicalJson.canonicalJson(c["value"]!), S.s(c["canonical"]), S.s(c["name"]))
            // parse, then re-serialize: the same text.
            XCTAssertEqual(try CanonicalJson.canonicalJson(XCTUnwrap(JSONValue.parse(S.s(c["canonical"])))), S.s(c["canonical"]))
        }
        for c in S.a(v["canonicalJson"]?["refusals"]) {
            XCTAssertThrowsError(try CanonicalJson.canonicalJson(XCTUnwrap(JSONValue.parse(S.s(c["json"])))), S.s(c["name"]))
        }
        XCTAssertThrowsError(try CanonicalJson.canonicalJson(XCTUnwrap(JSONValue.parse("[-0]"))))
        XCTAssertThrowsError(try CanonicalJson.canonicalJson(XCTUnwrap(JSONValue.parse("[\"\\ud800\"]"))))
        XCTAssertEqual(try CanonicalJson.canonicalJson(XCTUnwrap(JSONValue.parse("[1.0, 1e2]"))), "[1,100]")
        var n = 0
        for c in S.a(v["base64"]) {
            let b = CanonicalJson.b64Decode(S.s(c["b64"]))
            XCTAssertEqual(b.map(CanonicalJson.hex), S.optS(c["hex"]), S.s(c["b64"]))
            if let b { XCTAssertEqual(CanonicalJson.b64Encode(b), S.s(c["b64"])) }
            n += 1
        }
        XCTAssertEqual(n, 9)
    }

    func testBooleansAreNotNumbers() throws {
        let any = try JSONSerialization.jsonObject(with: Data("{\"t\":true,\"one\":1,\"f\":false,\"zero\":0}".utf8))
        let v = try XCTUnwrap(JSONValue(any: any))
        XCTAssertEqual(v["t"], .bool(true))
        XCTAssertEqual(v["one"], .number(1))
        XCTAssertEqual(v["f"], .bool(false))
        XCTAssertEqual(v["zero"], .number(0))
        XCTAssertFalse(v["t"]!.isOne)
        XCTAssertNil(v["t"]!.safeInt)
        XCTAssertEqual(JSONValue.parse("true"), .bool(true))
        XCTAssertNil(JSONValue.parse("{\"a\":1,}"))
        XCTAssertNil(JSONValue.parse("01"))
        // A BOM is kept (TextDecoder with ignoreBOM), so a JSON parse refuses it; malformed UTF-8 is refused.
        XCTAssertEqual(CanonicalJson.utf8Decode([0xef, 0xbb, 0xbf, 0x61]), "\u{FEFF}a")
        XCTAssertNil(JSONValue.parse(utf8: [0xef, 0xbb, 0xbf, 0x31]))
        XCTAssertNil(CanonicalJson.utf8Decode([0xed, 0xa0, 0x80]))
        XCTAssertEqual(CanonicalJson.jsNumberString(1e21), "1e+21")
        XCTAssertEqual(CanonicalJson.jsNumberString(1.5e-7), "1.5e-7")
        XCTAssertEqual(CanonicalJson.jsNumberString(0.000001), "0.000001")
        XCTAssertEqual(CanonicalJson.jsNumberString(123.25), "123.25")
        XCTAssertEqual(CanonicalJson.jsNumberString(9007199254740992), "9007199254740992")
    }

    private func attestation(_ v: JSONValue) -> MessagesKeyAttestation { MessagesAttestations.parseMessagesKeyAttestation(v)! }

    func testAttestation() throws {
        let v = try vectors()
        let a = try XCTUnwrap(v["attestation"])
        let keys = v["keys"]!
        let rq = a["request"]!
        var req = MessagesKeyAttestationRequest(username: S.s(rq["username"]), pseudonymPub: S.s(rq["pseudonymPub"]), renewOfHash: S.s(rq["renewOfHash"]),
                                                deviceCheckRef: S.s(rq["deviceCheckRef"]), issuedAt: S.i(rq["issuedAt"]))
        XCTAssertEqual(S.text(try MessagesAttestations.canonicalMessagesKeyAttestationRequest(req)), S.s(a["requestCanonical"]))
        XCTAssertTrue(MessagesAttestations.verifyMessagesKeyAttestationRequest(req, signature: S.s(a["requestSignature"]), devicePub: S.s(keys["devicePub"])))
        let mine = try MessagesAttestations.signMessagesKeyAttestationRequest(req, deviceSeed: S.h(keys["deviceSeed"]))
        XCTAssertTrue(MessagesAttestations.verifyMessagesKeyAttestationRequest(req, signature: mine, devicePub: S.s(keys["devicePub"])))
        req.deviceCheckRef = "none"
        XCTAssertFalse(MessagesAttestations.verifyMessagesKeyAttestationRequest(req, signature: S.s(a["requestSignature"]), devicePub: S.s(keys["devicePub"])))

        let signed = attestation(a["signed"]!)
        XCTAssertEqual(S.cj(signed.json), S.cj(a["signed"]!))
        XCTAssertEqual(CanonicalJson.b64Encode(S.h(a["abuseTagHex"])), signed.abuseTag)
        XCTAssertEqual(CanonicalJson.sha256Hex(S.h(a["abuseTagHex"])), signed.abuseTagHash)
        XCTAssertEqual(signed.signedBy, S.s(keys["caPub"]))
        XCTAssertEqual(S.text(try MessagesAttestations.canonicalMessagesKeyAttestation(signed)), S.s(a["canonical"]))
        XCTAssertEqual(try MessagesAttestations.messagesAttestationHash(signed), S.s(a["renewOfHash"]))
        var n = 0
        for c in S.a(a["checks"]) {
            let ctx = c["ctx"]!
            let r = MessagesAttestations.checkMessagesKeyAttestation(c["attestation"], caKeys: S.a(ctx["caKeys"]).map { S.s($0) },
                                                                     now: S.i(ctx["now"]), pseudonymPub: ctx["pseudonymPub"]?.string)
            XCTAssertEqual(r.code, S.s(c["expected"]), S.s(c["name"]))
            n += 1
        }
        XCTAssertEqual(n, 9)
    }

    private func delegation(_ j: JSONValue) -> WebDelegation {
        WebDelegation(scope: S.s(j["scope"]), origin: S.s(j["origin"]), audience: S.s(j["audience"]), principalPub: S.s(j["principalPub"]),
                      delegateAlg: S.s(j["delegateAlg"]), delegatePub: S.s(j["delegatePub"]), issuedAt: S.i(j["issuedAt"]),
                      expiresAt: S.i(j["expiresAt"]), nonce: S.s(j["nonce"]))
    }

    func testDelegationRevokeThreadStatement() throws {
        let v = try vectors()
        let d = v["derivations"]!
        let x = try XCTUnwrap(v["delegation"])
        let del = delegation(x["delegation"]!)
        XCTAssertEqual(S.cj(del.json), S.cj(x["delegation"]!))
        XCTAssertEqual(S.text(try WebDelegations.canonicalWebDelegation(del)), S.s(x["canonical"]))
        let want = WebDelegations.Want(origin: WebDelegations.voiciWebOrigin, audience: S.s(d["pageId"]), principalPub: S.s(d["pseudonymPub"]), now: S.i(v["t0"]))
        XCTAssertEqual(WebDelegations.checkWebDelegation(del.json, signature: x["signature"], want: want).code, "ok")
        let mine = try WebDelegations.signWebDelegation(del, principalSeed: S.h(d["pseudonymSeed"]))
        XCTAssertEqual(WebDelegations.checkWebDelegation(del.json, signature: .string(mine), want: want).code, "ok")
        var n = 0
        for c in S.a(x["checks"]) {
            let w = c["want"]!
            let ww = WebDelegations.Want(scope: S.s(w["scope"]), origin: S.s(w["origin"]), audience: S.s(w["audience"]),
                                         principalPub: S.s(w["principalPub"]), now: S.i(w["now"]), notAfter: w["notAfter"]?.safeInt)
            XCTAssertEqual(WebDelegations.checkWebDelegation(c["delegation"], signature: c["signature"], want: ww).code, S.s(c["expected"]), S.s(c["name"]))
            n += 1
        }
        XCTAssertEqual(n, 12)
        let rv = x["revoke"]!
        let revoke = try XCTUnwrap(WebDelegations.parseWebDelegationRevoke(rv["revoke"]))
        XCTAssertEqual(S.text(try WebDelegations.canonicalWebDelegationRevoke(revoke)), S.s(rv["canonical"]))
        XCTAssertTrue(WebDelegations.verifyWebDelegationRevoke(revoke, signature: S.s(rv["signature"]), principalPub: S.s(d["pseudonymPub"])))
        let myRevoke = try WebDelegations.signWebDelegationRevoke(revoke, principalSeed: S.h(d["pseudonymSeed"]))
        XCTAssertTrue(WebDelegations.verifyWebDelegationRevoke(revoke, signature: myRevoke, principalPub: S.s(d["pseudonymPub"])))
        XCTAssertFalse(WebDelegations.verifyWebDelegationRevoke(WebDelegationRevoke(delegatePub: revoke.delegatePub, issuedAt: revoke.issuedAt + 1),
                                                                signature: S.s(rv["signature"]), principalPub: S.s(d["pseudonymPub"])))

        let t = v["threadStatement"]!
        let ts = try XCTUnwrap(VoiciMessages.parseVoiciThreadStatement(t["statement"]))
        XCTAssertEqual(S.text(try VoiciMessages.canonicalVoiciThreadStatement(ts)), S.s(t["canonical"]))
        XCTAssertTrue(CanonicalJson.ed25519VerifyHex(S.s(t["signature"]), Array(S.s(t["canonical"]).utf8), S.s(d["pseudonymPub"])))
        let myTs = try VoiciMessages.signVoiciThreadStatement(ts, pseudonymSeed: S.h(d["pseudonymSeed"]))
        XCTAssertTrue(CanonicalJson.ed25519VerifyHex(myTs, Array(S.s(t["canonical"]).utf8), S.s(d["pseudonymPub"])))
    }

    private func plaintext(_ j: JSONValue) -> VoiciPlaintext { VoiciPlaintext(text: S.s(j["text"]), replyTo: j["replyTo"]?.string) }

    private func randomness(_ j: JSONValue) -> VoiciSealRandomness {
        VoiciSealRandomness(cek: S.h(j["cek"]), nonce: S.h(j["nonce"]), eseeds: S.a(j["eseeds"]).map { S.h($0) })
    }

    func testMessage() throws {
        let v = try vectors()
        let d = v["derivations"]!, keys = v["keys"]!
        let m = try XCTUnwrap(v["message"])
        let env = m["envelope"]!
        XCTAssertEqual(S.cj(plaintext(m["plaintext"]!).json), S.s(m["plaintextCanonical"]))
        let body = try VoiciMessages.sealVoiciBody(conv: S.s(d["conv"]), msgId: S.s(env["msgId"]), sentAt: S.i(env["sentAt"]), fromPub: S.s(d["pseudonymPub"]),
                                                   recipients: [S.h(d["inboxPub"]), S.h(d["threadPub"])], plaintext: plaintext(m["plaintext"]!),
                                                   randomness: randomness(m["randomness"]!))
        XCTAssertEqual(S.text(body), S.s(m["bodyText"]))
        XCTAssertEqual(CanonicalJson.b64Encode(body), S.s(env["bodyB64"]))
        let parsed = try XCTUnwrap(WebEnvelope.parseWebEnvelope(env))
        XCTAssertEqual(S.cj(parsed.json), S.cj(env))
        XCTAssertEqual(S.text(try WebEnvelope.canonicalWebEnvelope(parsed)), S.s(m["canonical"]))
        XCTAssertTrue(WebEnvelope.verifyWebEnvelopeSignature(parsed, signerPub: S.s(keys["browserPub"])))
        XCTAssertNotNil(WebEnvelope.parseWebEnvelope(.string(S.cj(env))))

        // High S verifies too (WebCrypto does not normalize): (r, n - s).
        var raw = try CanonicalJson.hexToBytes(parsed.sig)
        raw.replaceSubrange(32..<64, with: CanonicalJson.subtract(CanonicalJson.p256Order, Array(raw[32..<64])))
        var high = parsed
        high.sig = CanonicalJson.hex(raw)
        XCTAssertNotEqual(high.sig, parsed.sig)
        XCTAssertTrue(WebEnvelope.verifyWebEnvelopeSignature(high, signerPub: S.s(keys["browserPub"])))
        var tampered = parsed
        tampered.seq = 2
        XCTAssertFalse(WebEnvelope.verifyWebEnvelopeSignature(tampered, signerPub: S.s(keys["browserPub"])))

        var n = 0
        for c in S.a(m["checks"]) {
            let x = c["ctx"]!
            let ctx = VoiciMessageCheckContext(
                pageId: S.s(x["pageId"]), acceptsMessages: x["acceptsMessages"] == .bool(true), origin: S.s(x["origin"]),
                caKeys: S.a(x["caKeys"]).map { S.s($0) }, now: S.i(x["now"]),
                blocked: x["blocked"].map { Set(S.a($0).map { S.s($0) }) }, revoked: x["revoked"].map { Set(S.a($0).map { S.s($0) }) },
                rateLimit: x["rateLimited"] == .bool(true) ? { _ in .rateLimited } : nil)
            XCTAssertEqual(VoiciMessages.checkVoiciMessage(c["envelope"]!, ctx).code, S.s(c["expected"]), S.s(c["name"]))
            n += 1
        }
        XCTAssertEqual(n, 24)
        for c in S.a(m["open"]) {
            let r = try VoiciMessages.openVoiciBody(body, conv: S.s(c["conv"]), msgId: S.s(c["msgId"]), recipientSeed: S.h(c["seed"]))
            let got: JSONValue
            switch r {
            case .ok(let p): got = ["ok": true, "plaintext": p.json]
            case .refused(let code): got = ["ok": false, "code": .string(code.rawValue)]
            }
            XCTAssertEqual(S.cj(got), S.cj(c["expected"]!), S.s(c["name"]))
        }
        // Fresh randomness round-trips and never repeats.
        let o = (conv: S.s(d["conv"]), msgId: String(repeating: "55", count: 16))
        let a1 = try VoiciMessages.sealVoiciBody(conv: o.conv, msgId: o.msgId, sentAt: 1, fromPub: S.s(d["pseudonymPub"]),
                                                 recipients: [S.h(d["inboxPub"]), S.h(d["threadPub"])], plaintext: VoiciPlaintext(text: "x", replyTo: nil))
        let a2 = try VoiciMessages.sealVoiciBody(conv: o.conv, msgId: o.msgId, sentAt: 1, fromPub: S.s(d["pseudonymPub"]),
                                                 recipients: [S.h(d["inboxPub"]), S.h(d["threadPub"])], plaintext: VoiciPlaintext(text: "x", replyTo: nil))
        XCTAssertNotEqual(a1, a2)
        XCTAssertEqual(try VoiciMessages.openVoiciBody(a1, conv: o.conv, msgId: o.msgId, recipientSeed: S.h(d["threadSeed"])).value, VoiciPlaintext(text: "x", replyTo: nil))
        XCTAssertThrowsError(try VoiciMessages.sealVoiciBody(conv: o.conv, msgId: o.msgId, sentAt: 1, fromPub: S.s(d["pseudonymPub"]),
                                                             recipients: [S.h(d["inboxPub"]), S.h(d["threadPub"])], plaintext: VoiciPlaintext(text: "a\u{202E}b", replyTo: nil)))
    }

    func testReplyAndDraft() throws {
        let v = try vectors()
        let d = v["derivations"]!
        let r = try XCTUnwrap(v["reply"])
        let env = r["envelope"]!
        let body = try VoiciMessages.sealVoiciBody(conv: S.s(d["conv"]), msgId: S.s(env["msgId"]), sentAt: S.i(env["sentAt"]), fromPub: S.s(d["ownerSignPub"]),
                                                   recipients: [S.h(d["threadPub"]), S.h(d["inboxPub"])], plaintext: plaintext(r["plaintext"]!),
                                                   randomness: randomness(r["randomness"]!))
        XCTAssertEqual(S.text(body), S.s(r["bodyText"]))
        let parsed = try XCTUnwrap(WebEnvelope.parseWebEnvelope(env))
        XCTAssertEqual(S.text(try WebEnvelope.canonicalWebEnvelope(parsed)), S.s(r["canonical"]))
        XCTAssertTrue(WebEnvelope.verifyWebEnvelopeSignature(parsed, signerPub: S.s(d["ownerSignPub"])))
        var unsigned = parsed
        unsigned.sigAlg = nil; unsigned.sig = ""
        let mine = try WebEnvelope.signWebEnvelopeEd25519(unsigned, seed: S.h(d["ownerSignSeed"]))
        XCTAssertEqual(VoiciMessages.checkVoiciReply(mine.json, pageId: S.s(d["pageId"]), ownerSignPub: S.s(d["ownerSignPub"]), conv: S.s(d["conv"])).code, "ok")
        XCTAssertEqual(try VoiciMessages.openVoiciBody(body, conv: S.s(d["conv"]), msgId: S.s(env["msgId"]), recipientSeed: S.h(d["threadSeed"])).value,
                       plaintext(r["plaintext"]!))
        var n = 0
        for c in S.a(r["checks"]) {
            let x = c["ctx"]!
            let got = VoiciMessages.checkVoiciReply(c["envelope"]!, pageId: S.s(x["pageId"]), ownerSignPub: S.s(x["ownerSignPub"]),
                                                    conv: x["conv"]?.string, freshAt: x["freshAt"]?.safeInt)
            XCTAssertEqual(got.code, S.s(c["expected"]), S.s(c["name"]))
            n += 1
        }
        XCTAssertEqual(n, 8)

        let x = try XCTUnwrap(v["draft"])
        let op = try XCTUnwrap(VoiciMessages.parseVoiciDraftOp(x["op"]))
        XCTAssertEqual(S.cj(op.json), S.cj(x["op"]!))
        let username = S.s(x["username"])
        let sealed = try VoiciMessages.sealVoiciDraft(draftsKey: S.h(d["draftsKey"]), username: username, op: op, nonce: S.h(x["nonce"]))
        XCTAssertEqual(S.text(sealed), S.s(x["bodyText"]))
        let opened = try XCTUnwrap(VoiciMessages.openVoiciDraft(draftsKey: S.h(d["draftsKey"]), username: username, opId: op.opId, bodyBytes: Array(S.s(x["bodyText"]).utf8)))
        XCTAssertEqual(S.cj(opened.json), S.cj(x["op"]!))
        XCTAssertNil(VoiciMessages.openVoiciDraft(draftsKey: S.h(d["draftsKey"]), username: username, opId: String(repeating: "00", count: 16), bodyBytes: sealed))
        let ok = x["grantAccepted"]!
        let checkGrant: (JSONValue, String, String) -> Bool = { g, s, pub in
            S.cj(g) == S.cj(ok["grant"]!) && s == S.s(ok["grantSignature"]) && pub == S.s(ok["devicePub"])
        }
        n = 0
        for c in S.a(x["checks"]) {
            let got = VoiciMessages.checkVoiciDraft(c["envelope"]!, username: S.s(c["ctx"]?["username"]), checkGrant: checkGrant, freshAt: c["ctx"]?["freshAt"]?.safeInt)
            XCTAssertEqual(got.code, S.s(c["expected"]), S.s(c["name"]))
            n += 1
        }
        XCTAssertEqual(n, 7)
        for c in S.a(x["opCases"]) {
            XCTAssertEqual(.bool(VoiciMessages.parseVoiciDraftOp(c["op"]) != nil), c["expected"], S.s(c["name"]))
        }
    }

    func testAckBlockStateReports() throws {
        let v = try vectors()
        let d = v["derivations"]!, keys = v["keys"]!
        let ack = try XCTUnwrap(v["ack"])
        let a = try XCTUnwrap(VoiciMessages.verifyVoiciAck(ack["message"], signerPub: S.s(d["ownerSignPub"]), msgId: S.s(ack["message"]?["msgId"])))
        XCTAssertEqual(S.text(try VoiciMessages.canonicalVoiciAck(a)), S.s(ack["canonical"]))
        let mine = try VoiciMessages.signVoiciAck(a, seed: S.h(d["ownerSignSeed"]))
        XCTAssertNotNil(VoiciMessages.verifyVoiciAck(a.json(signature: mine), signerPub: S.s(d["ownerSignPub"]), msgId: a.msgId, conv: a.conv))
        for c in S.a(ack["cases"]) {
            let got = VoiciMessages.verifyVoiciAck(c["ack"], signerPub: S.s(c["signerPub"]), msgId: S.s(c["want"]?["msgId"]), conv: c["want"]?["conv"]?.string)
            XCTAssertEqual(.bool(got != nil), c["expected"], S.s(c["name"]))
        }

        let blk = try XCTUnwrap(v["block"])
        let b = try XCTUnwrap(VoiciMessages.parseVoiciBlock(blk["block"]))
        XCTAssertEqual(S.text(try VoiciMessages.canonicalVoiciBlock(b)), S.s(blk["canonical"]))
        XCTAssertTrue(VoiciMessages.verifyVoiciBlock(b, signature: S.s(blk["signature"]), ownerSignPub: S.s(d["ownerSignPub"])))
        var unblock = b; unblock.op = "unblock"
        XCTAssertFalse(VoiciMessages.verifyVoiciBlock(unblock, signature: S.s(blk["signature"]), ownerSignPub: S.s(d["ownerSignPub"])))
        let myBlock = try VoiciMessages.signVoiciBlock(b, ownerSignSeed: S.h(d["ownerSignSeed"]))
        XCTAssertTrue(VoiciMessages.verifyVoiciBlock(b, signature: myBlock, ownerSignPub: S.s(d["ownerSignPub"])))

        let s = try XCTUnwrap(v["state"])
        let sa = try XCTUnwrap(VoiciMessages.parseMessagesState(s["a"]))
        let sb = try XCTUnwrap(VoiciMessages.parseMessagesState(s["b"]))
        XCTAssertEqual(S.cj(sa.json), S.cj(s["a"]!))
        XCTAssertEqual(S.cj(VoiciMessages.mergeMessagesState(local: sa, remote: sb).json), S.cj(s["merged"]!))
        let sealed = try VoiciMessages.sealMessagesState(stateKey: S.h(d["stateKey"]), username: S.s(s["username"]), version: S.i(s["version"]), state: sa, nonce: S.h(s["nonce"]))
        XCTAssertEqual(S.cj(sealed.json), S.cj(s["sealed"]!))
        let opened = try XCTUnwrap(VoiciMessages.openMessagesState(stateKey: S.h(d["stateKey"]), username: S.s(s["username"]), blob: s["sealed"]))
        XCTAssertEqual(S.cj(opened.json), S.cj(s["a"]!))
        var other = s["sealed"]!.object!
        other["version"] = 5
        XCTAssertNil(VoiciMessages.openMessagesState(stateKey: S.h(d["stateKey"]), username: S.s(s["username"]), blob: .object(other)))

        let rp = try XCTUnwrap(v["reports"])
        for k in ["message", "messageWithText"] {
            let r = rp[k]!["report"]!
            let rep = VoiciMessageReport(pageId: S.s(r["pageId"]), envelope: r["envelope"]!, reason: S.s(r["reason"]), attached: r["attached"]?.string, issuedAt: S.i(r["issuedAt"]))
            XCTAssertEqual(S.text(try VoiciMessages.canonicalVoiciMessageReport(rep)), S.s(rp[k]?["canonical"]), k)
            XCTAssertTrue(VoiciMessages.verifyVoiciMessageReport(rep, signature: S.s(rp[k]?["signature"]), ownerSignPub: S.s(d["ownerSignPub"])), k)
            let mine = try VoiciMessages.signVoiciMessageReport(rep, ownerSignSeed: S.h(d["ownerSignSeed"]))
            XCTAssertTrue(VoiciMessages.verifyVoiciMessageReport(rep, signature: mine, ownerSignPub: S.s(d["ownerSignPub"])), k)
        }
        let pr = rp["page"]!["report"]!
        let page = VoiciPageReport(username: S.s(pr["username"]), seq: S.i(pr["seq"]), reason: S.s(pr["reason"]), note: S.s(pr["note"]), issuedAt: S.i(pr["issuedAt"]))
        XCTAssertEqual(S.text(try VoiciMessages.canonicalVoiciPageReport(page)), S.s(rp["page"]?["canonical"]))
        XCTAssertTrue(WebEnvelope.p256VerifyP1363(S.s(rp["page"]?["signature"]), Array(S.s(rp["page"]?["canonical"]).utf8), S.s(keys["browserPub"])))
    }

    func testSignInAndPhoneWeb() throws {
        let v = try vectors()
        let si = try XCTUnwrap(v["signIn"])
        let caKeys = S.a(si["ctx"]?["caKeys"]).map { S.s($0) }
        var n = 0
        for c in S.a(si["checks"]) {
            let req = try XCTUnwrap(VoiciMessages.parseVoiciSignInRequest(c["request"]), S.s(c["name"]))
            let got = VoiciMessages.checkVoiciSignInAnswer(c["answer"], request: req, caKeys: caKeys, now: S.i(si["ctx"]?["now"]))
            XCTAssertEqual(got.code, S.s(c["expected"]), S.s(c["name"]))
            if case .ok(let answer) = got { XCTAssertEqual(S.cj(answer.json), S.cj(c["answer"]!)) }
            n += 1
        }
        XCTAssertEqual(n, 6)

        let c0 = v["constants"]!
        XCTAssertEqual(S.a(c0["phoneWebOrigins"]).map { S.s($0) }, VoiciPhoneWeb.origins)
        XCTAssertEqual(S.a(c0["phoneWebOriginsGym"]).map { S.s($0) }, VoiciPhoneWeb.originsGym)
        XCTAssertEqual(S.s(c0["webOrigin"]), WebDelegations.voiciWebOrigin)
        XCTAssertEqual(S.s(c0["webOriginGym"]), WebDelegations.voiciWebOriginGym)
        XCTAssertEqual(S.i(c0["envelopeMaxBytes"]), Int64(WebEnvelope.maxBytes))
        XCTAssertEqual(S.i(c0["envelopeMaxBodyBytes"]), Int64(WebEnvelope.maxBodyBytes))
        XCTAssertEqual(S.i(c0["draftMaxEnvelopeBytes"]), Int64(VoiciMessages.draftMaxEnvelopeBytes))
        XCTAssertEqual(S.i(c0["draftMaxBodyBytes"]), Int64(VoiciMessages.draftMaxBodyBytes))
        XCTAssertEqual(S.i(c0["sendSkewMs"]), VoiciMessages.sendSkewMs)
        XCTAssertEqual(S.i(c0["attestationTtlMs"]), MessagesAttestations.ttlMs)
        XCTAssertEqual(S.i(c0["phoneDeliverMaxBytes"]), Int64(VoiciPhoneWeb.deliverMaxBytes))

        n = 0
        for c in S.a(v["phoneWeb"]?["cases"]) {
            let r = c["request"]!
            let req = VoiciPhoneWeb.Request(method: S.s(r["method"]), path: S.s(r["path"]), host: S.s(r["host"]), origin: r["origin"]?.string,
                                            contentType: r["contentType"]?.string, acrMethod: r["acrMethod"]?.string, acrHeaders: r["acrHeaders"]?.string)
            let got = VoiciPhoneWeb.phoneWebCheck(req, hostname: S.s(c["hostname"]), origins: S.a(c["origins"]).map { S.s($0) })
            XCTAssertEqual(S.cj(got.json), S.cj(c["expected"]!), S.s(c["name"]))
            n += 1
        }
        XCTAssertEqual(n, 16)
        for c in S.a(v["phoneWeb"]?["liveAnswers"]) {
            XCTAssertEqual(.bool(VoiciPhoneWeb.parsePhoneLiveAnswer(c["answer"]) != nil), c["expected"])
        }
    }

    func testThreadFetchCanonical() throws {
        let t = try XCTUnwrap(try vectors()["threadFetch"])
        let f = VoiciThreadFetch(conv: S.s(t["fetch"]?["conv"]), since: S.s(t["fetch"]?["since"]), issuedAt: S.i(t["fetch"]?["issuedAt"]))
        XCTAssertEqual(String(decoding: try f.canonicalBytes(), as: UTF8.self), S.s(t["canonical"]))
        XCTAssertThrowsError(try VoiciThreadFetch(conv: "x", since: "", issuedAt: 1).canonicalBytes())
    }
}
