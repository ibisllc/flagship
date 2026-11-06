import XCTest
@testable import FlagshipCore

/// Pins VoiciPageRemove.swift to packages/protocol/test-vectors/voici-page-remove/vectors.json
/// (tools/voici-page-remove-vectors.ts; the TS replay is packages/protocol/tests/voiciPageRemove.test.ts).
final class VoiciPageRemoveVectorTests: XCTestCase {
    typealias S = VoiciVectorSupport

    private func vectors() throws -> JSONValue {
        try S.load("packages/protocol/test-vectors/voici-page-remove/vectors.json", from: #filePath)
    }

    func testCanonicalBytes() throws {
        let v = try vectors()
        let f = try XCTUnwrap(v["fields"])
        XCTAssertEqual(VoiciPageRemove.tag, S.s(v["tag"]))
        let bytes = try VoiciPageRemove.canonical(username: S.s(f["username"]), pageId: S.s(f["pageId"]), seq: S.i(f["seq"]), issuedAt: S.i(f["issuedAt"]))
        XCTAssertEqual(S.text(bytes), S.s(v["canonical"]))
    }

    func testSignsLikeTheVectors() throws {
        let v = try vectors()
        let f = try XCTUnwrap(v["fields"])
        for (kind, seedKey, signed) in [("admin-root", "adminRootSeed", "signed"), ("irk", "irkSeed", "signedIrk")] {
            let r = try VoiciPageRemove.sign(username: S.s(f["username"]), pageId: S.s(f["pageId"]), seq: S.i(f["seq"]), issuedAt: S.i(f["issuedAt"]),
                                             signerKind: kind, signerSeed: S.h(v["keys"]?[seedKey]))
            // CryptoKit's Ed25519 is randomized: the fields match the TS envelope and the signature verifies.
            var want = try XCTUnwrap(VoiciPageRemove.parse(try XCTUnwrap(v[signed])))
            want.signature = r.signature
            XCTAssertEqual(r, want, kind)
            if case .ok = VoiciPageRemove.check(r.json, username: r.username, sensitiveKind: kind, sensitivePub: r.signerPub, storedSeq: r.seq - 1,
                                                storedPageId: r.pageId, now: r.issuedAt) {} else { XCTFail("own signature refused") }
            XCTAssertEqual(VoiciPageRemove.parse(r.json), r)
        }
    }

    func testEveryCase() throws {
        let v = try vectors()
        for c in S.a(v["cases"]) {
            let ctx = try XCTUnwrap(c["ctx"])
            let got = VoiciPageRemove.check(try XCTUnwrap(c["remove"]), username: S.s(ctx["username"]), sensitiveKind: S.s(ctx["sensitiveKind"]),
                                            sensitivePub: S.s(ctx["sensitivePub"]), storedSeq: S.i(ctx["storedSeq"]),
                                            storedPageId: S.optS(ctx["storedPageId"]), now: S.i(ctx["now"]))
            let code: String
            switch got {
            case .ok: code = "ok"
            case .refused(let r): code = r.rawValue
            }
            XCTAssertEqual(code, S.s(c["expected"]), S.s(c["name"]))
        }
    }
}
