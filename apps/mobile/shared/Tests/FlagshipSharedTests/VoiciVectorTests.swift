import XCTest
@testable import FlagshipCore

/// Helpers shared by VoiciVectorTests and MessagesVectorTests: the vectors are read with the port's own strict JSON
/// parser (so a lone-surrogate string in them stays a lone surrogate) and compared as canonical JSON.
enum VoiciVectorSupport {
    static func load(_ relative: String, from file: String) throws -> JSONValue {
        var dir = URL(fileURLWithPath: file).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONValue.parse(utf8: [UInt8](try Data(contentsOf: url))), "\(relative) does not parse")
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("\(relative) not found above \(file)")
    }

    static func s(_ v: JSONValue?) -> String { v!.string! }
    static func i(_ v: JSONValue?) -> Int64 { v!.safeInt! }
    static func a(_ v: JSONValue?) -> [JSONValue] { v!.array! }
    static func h(_ v: JSONValue?) -> [UInt8] { try! CanonicalJson.hexToBytes(v!.string!) }
    static func cj(_ v: JSONValue) -> String { try! CanonicalJson.canonicalJson(v) }
    static func text(_ b: [UInt8]) -> String { String(decoding: b, as: UTF8.self) }
    static func optS(_ v: JSONValue?) -> String? { v?.string }
}

/// Pins the Swift voi.ci page port (VoiciText.swift, VoiciPage.swift) to packages/protocol/test-vectors/voici/vectors.json
/// (tools/voici-vectors.ts; the TS replay is packages/protocol/tests/voiciVectors.test.ts).
final class VoiciVectorTests: XCTestCase {
    typealias S = VoiciVectorSupport

    private func vectors() throws -> JSONValue {
        try S.load("packages/protocol/test-vectors/voici/vectors.json", from: #filePath)
    }

    func testConstants() throws {
        let c = try XCTUnwrap(try vectors()["constants"])
        XCTAssertEqual(S.i(c["profileMaxBytes"]), Int64(VoiciPage.profileMaxBytes))
        XCTAssertEqual(S.i(c["chunkMaxBytes"]), Int64(VoiciPage.chunkMaxBytes))
        XCTAssertEqual(S.i(c["chunkMaxPosts"]), Int64(VoiciPage.chunkMaxPosts))
        XCTAssertEqual(S.i(c["avatarMaxBytes"]), Int64(VoiciPage.avatarMaxBytes))
        XCTAssertEqual(S.i(c["cardImageMaxBytes"]), Int64(VoiciPage.cardImageMaxBytes))
        XCTAssertEqual(S.i(c["indexMaxBytes"]), Int64(VoiciPage.indexMaxBytes))
        XCTAssertEqual(S.i(c["indexMaxPieces"]), Int64(VoiciPage.indexMaxPieces))
        XCTAssertEqual(S.i(c["indexSkewMs"]), VoiciPage.indexSkewMs)
        XCTAssertEqual(S.i(c["linkUrlMax"]), Int64(VoiciText.linkUrlMax))
        let rules = try XCTUnwrap(c["textRules"]?.object)
        XCTAssertEqual(Set(rules.keys), Set(VoiciText.Field.allCases.map(\.rawValue)))
        for (k, r) in rules {
            let mine = VoiciText.rules[VoiciText.Field(rawValue: k)!]!
            XCTAssertEqual([S.i(r["min"]), S.i(r["max"])], [Int64(mine.min), Int64(mine.max)], k)
            XCTAssertEqual(r["newline"], .bool(mine.newline), k)
        }
    }

    func testTextRules() throws {
        let t = try XCTUnwrap(try vectors()["text"])
        var n = 0
        for c in S.a(t["check"]) {
            let field = try XCTUnwrap(VoiciText.Field(rawValue: S.s(c["field"])))
            XCTAssertEqual(VoiciText.checkVoiciText(field, c["input"])?.rawValue ?? "ok", S.s(c["expected"]), "\(S.s(c["field"])) case \(n)")
            n += 1
        }
        XCTAssertEqual(n, 25)
        for c in S.a(t["prepare"]) {
            let field = try XCTUnwrap(VoiciText.Field(rawValue: S.s(c["field"])))
            let r = VoiciText.prepareVoiciText(field, S.s(c["input"]))
            let got: JSONValue
            switch r {
            case .ok(let text): got = ["ok": true, "text": .string(text)]
            case .refused(let code): got = ["ok": false, "code": .string(code.rawValue)]
            }
            XCTAssertEqual(S.cj(got), S.cj(c["expected"]!))
            // NFC compared as scalars: Swift's String == would hide a decomposed "é".
            if case .ok(let text) = r { XCTAssertTrue(text.unicodeScalars.elementsEqual(S.s(c["expected"]?["text"]).unicodeScalars)) }
        }
    }

    func testLinkUrlsMatchesSitesNamesJpegs() throws {
        let v = try vectors()
        for c in S.a(v["linkUrls"]) {
            XCTAssertEqual(VoiciText.checkVoiciLinkUrl(S.s(c["url"]), allowMailto: c["allowMailto"] == .bool(true))?.rawValue, S.optS(c["expected"]), S.s(c["url"]))
        }
        for c in S.a(v["linkMatches"]) {
            let got = JSONValue.array(VoiciText.findVoiciLinks(S.s(c["text"])).map(\.json))
            XCTAssertEqual(S.cj(got), S.cj(c["matches"]!), S.s(c["text"]))
        }
        XCTAssertEqual(S.cj(.array(VoiciText.linkSites.map(\.json))), S.cj(v["linkSites"]!["table"]!))
        for c in S.a(v["linkSites"]?["cases"]) {
            XCTAssertEqual(VoiciText.voiciLinkSite(S.s(c["url"])), S.optS(c["site"]), S.s(c["url"]))
        }
        for c in S.a(v["pseudonymNames"]) {
            XCTAssertEqual(try VoiciText.voiciPseudonymCode(S.s(c["pub"])), S.s(c["code"]))
            XCTAssertEqual(try VoiciText.voiciPseudonymName(S.s(c["pub"])), S.s(c["name"]))
        }
        XCTAssertThrowsError(try VoiciText.voiciPseudonymCode("AB"))
        for c in S.a(v["namespaceKeys"]) { XCTAssertEqual(VoiciPage.voiciNamespaceKey(S.s(c["name"])), S.s(c["key"])) }
        for c in S.a(v["jpegs"]) {
            XCTAssertEqual(c["isJpeg"], .bool(VoiciPage.isVoiciJpeg(S.h(c["hex"]))), S.s(c["name"]))
            XCTAssertEqual(c["hasMetadata"], .bool(VoiciPage.voiciJpegHasMetadata(S.h(c["hex"]))), S.s(c["name"]))
        }
    }

    func testFindLinksFollowsJavaScriptCaseRules() {
        // JavaScript /i (no u flag) never folds the Kelvin sign onto "k"; ICU would.
        XCTAssertTrue(VoiciText.findVoiciLinks("https://\u{212A}.example").isEmpty)
        XCTAssertEqual(VoiciText.findVoiciLinks("😀 https://a.example/x").first?.start, 3)
        XCTAssertEqual(VoiciText.checkVoiciLinkUrl("https://example.com\n"), .malformed)
    }

    func testPieces() throws {
        let p = try XCTUnwrap(try vectors()["pieces"])
        XCTAssertEqual(S.cj(p["profile"]!), S.s(p["profileText"]))
        let profile = try XCTUnwrap(VoiciPage.parseVoiciProfile(p["profile"]))
        XCTAssertEqual(S.cj(profile.json), S.s(p["profileText"]))
        for c in S.a(p["profileCases"]) {
            let ok = VoiciPage.parseVoiciProfilePiece(Array(S.s(c["text"]).utf8)) != nil
            XCTAssertEqual(.bool(ok), c["expected"], S.s(c["name"]))
        }
        for c in S.a(p["chunkCases"]) {
            let ok = VoiciPage.parseVoiciChunkPiece(Array(S.s(c["text"]).utf8), n: S.i(c["n"])) != nil
            XCTAssertEqual(.bool(ok), c["expected"], S.s(c["name"]))
        }
        for (n, t) in S.a(p["chunkTexts"]).enumerated() {
            let c = try XCTUnwrap(VoiciPage.parseVoiciChunkPiece(Array(S.s(t).utf8), n: Int64(n)))
            XCTAssertEqual(S.cj(c.json), S.s(t))
        }
    }

    private func body(_ b: JSONValue) -> VoiciPageIndex {
        VoiciPageIndex(username: S.s(b["username"]), pageId: S.s(b["pageId"]), seq: S.i(b["seq"]), issuedAt: S.i(b["issuedAt"]),
                       acceptsMessages: S.i(b["acceptsMessages"]), inboxEpoch: S.i(b["inboxEpoch"]), inboxPub: S.s(b["inboxPub"]),
                       ownerSignPub: S.s(b["ownerSignPub"]),
                       pieces: S.a(b["pieces"]).map { VoiciPieceRef(role: S.s($0["role"]), sha256: S.s($0["sha256"]), size: S.i($0["size"])) },
                       signerKind: S.s(b["signerKind"]))
    }

    func testIndex() throws {
        let v = try vectors()
        let x = try XCTUnwrap(v["index"])
        let signedJson = x["signed"]!
        let signed = try XCTUnwrap(VoiciPage.parseVoiciPageIndex(signedJson))
        XCTAssertEqual(S.cj(signed.json), S.cj(signedJson))
        XCTAssertEqual(S.text(try VoiciPage.canonicalVoiciPageIndex(signed)), S.s(x["canonical"]))
        let keys = v["keys"]!
        // Our own signature (randomized): same bytes and fields, and the reader accepts it.
        var shuffled = body(x["body"]!)
        shuffled.pieces.reverse()
        let mine = try VoiciPage.signVoiciPageIndex(shuffled, signerSeed: S.h(keys["adminRootSeed"]))
        XCTAssertEqual(S.text(try VoiciPage.canonicalVoiciPageIndex(mine)), S.s(x["canonical"]))
        var mineNoSig = mine; mineNoSig.signature = signed.signature
        XCTAssertEqual(S.cj(mineNoSig.json), S.cj(signedJson))
        XCTAssertEqual(VoiciPage.checkVoiciPageIndex(mine.json, username: "alice", sensitiveKind: "admin-root", sensitivePub: S.s(keys["adminRootPub"])).code, "ok")

        let pieces = v["pieces"]!
        let profile = try XCTUnwrap(VoiciPage.parseVoiciProfile(pieces["profile"]))
        let chunks = S.a(pieces["chunkTexts"]).enumerated().map { VoiciPage.parseVoiciChunkPiece(Array(S.s($0.element).utf8), n: Int64($0.offset))! }
        XCTAssertTrue(VoiciPage.voiciPieceRefsOk(signed, profile: profile, chunks: chunks))
        var noAvatar = profile; noAvatar.avatar = nil
        XCTAssertFalse(VoiciPage.voiciPieceRefsOk(signed, profile: noAvatar, chunks: chunks))

        var n = 0
        for c in S.a(x["checks"]) {
            let ctx = c["ctx"]!
            let r = VoiciPage.checkVoiciPageIndex(c["index"]!, username: S.s(ctx["username"]), sensitiveKind: S.s(ctx["sensitiveKind"]),
                                                  sensitivePub: S.s(ctx["sensitivePub"]), highestSeenSeq: ctx["highestSeenSeq"]?.safeInt,
                                                  pageId: ctx["pageId"]?.string)
            XCTAssertEqual(r.code, S.s(c["expected"]), S.s(c["name"]))
            n += 1
        }
        XCTAssertEqual(n, 22)
        for c in S.a(x["publishChecks"]) {
            let ctx = c["ctx"]!
            let r = VoiciPage.checkVoiciPublish(c["index"]!, username: S.s(ctx["username"]), sensitiveKind: S.s(ctx["sensitiveKind"]),
                                                sensitivePub: S.s(ctx["sensitivePub"]), storedSeq: S.i(ctx["storedSeq"]),
                                                storedPageId: ctx["storedPageId"]?.string, now: S.i(ctx["now"]))
            XCTAssertEqual(r.code, S.s(c["expected"]), S.s(c["name"]))
        }
        let viaText = try XCTUnwrap(VoiciPage.parseVoiciPageIndex(.string(S.cj(signedJson))))
        XCTAssertEqual(S.cj(viaText.json), S.cj(signedJson))
        XCTAssertNil(VoiciPage.parseVoiciPageIndex(.string(String(repeating: "x", count: VoiciPage.indexMaxBytes + 1))))
    }

    func testPieceUploadChunkingMerge() throws {
        let v = try vectors()
        let u = try XCTUnwrap(v["pieceUpload"])
        func upload(_ j: JSONValue) -> VoiciPieceUpload {
            VoiciPieceUpload(username: S.s(j["username"]), pageId: S.s(j["pageId"]), sha256: S.s(j["sha256"]), size: S.i(j["size"]), issuedAt: S.i(j["issuedAt"]))
        }
        let cases = S.a(u["cases"])
        XCTAssertEqual(S.text(try VoiciPage.canonicalVoiciPieceUpload(upload(cases[0]["upload"]!))), S.s(u["canonical"]))
        for c in cases {
            XCTAssertEqual(.bool(VoiciPage.verifyVoiciPieceUpload(upload(c["upload"]!), signature: S.s(c["signature"]), signerPub: S.s(u["signerPub"]))), c["expected"], S.s(c["name"]))
        }
        let mySig = try VoiciPage.signVoiciPieceUpload(upload(cases[0]["upload"]!), signerSeed: S.h(v["keys"]?["adminRootSeed"]))
        XCTAssertTrue(VoiciPage.verifyVoiciPieceUpload(upload(cases[0]["upload"]!), signature: mySig, signerPub: S.s(u["signerPub"])))

        // Chunking: the 22 posts of the chunk pieces, fed in reverse, come back in the vectors' chunks.
        let posts = S.a(v["pieces"]?["chunkTexts"]).enumerated().flatMap { VoiciPage.parseVoiciChunkPiece(Array(S.s($0.element).utf8), n: Int64($0.offset))!.posts }
        XCTAssertEqual(posts.map(\.id), S.a(v["chunking"]?["posts"]).map { S.s($0) })
        let chunked = VoiciPage.chunkVoiciPosts(posts.reversed())
        XCTAssertEqual(chunked.map { $0.map(\.id) }, S.a(v["chunking"]?["chunks"]).map { S.a($0).map { S.s($0) } })

        var n = 0
        for c in S.a(v["merge"]) {
            let p = c["published"]!
            let state = VoiciPageState(profile: try XCTUnwrap(VoiciPage.parseVoiciProfile(p["profile"])), acceptsMessages: S.i(p["acceptsMessages"]),
                                       chunks: S.a(p["chunks"]).map { S.a($0).map { VoiciPage.parseVoiciPost($0)! } }, issuedAt: S.i(p["issuedAt"]))
            let ops = try S.a(c["ops"]).map { try XCTUnwrap(VoiciMessages.parseVoiciDraftOp($0)) }
            XCTAssertEqual(S.cj(VoiciPage.mergeVoiciPage(state, ops: ops).json), S.cj(c["expected"]!), S.s(c["name"]))
            n += 1
        }
        XCTAssertEqual(n, 8)
    }
}
