import XCTest
@testable import FlagshipCore

/// Pins VoucherLink.swift to packages/protocol/test-vectors/voucher-link/ (packages/protocol/tests/genVoucherLinkVectors.ts;
/// the TS replay is voucherLinkVectors.test.ts).
final class VoucherLinkVectorTests: XCTestCase {
    typealias S = VoiciVectorSupport

    private func boolOf(_ v: JSONValue?) -> Bool? { if case .bool(let b)? = v { return b }; return nil }
    private func vectors() throws -> JSONValue { try S.load("packages/protocol/test-vectors/voucher-link/vectors.json", from: #filePath) }
    private func key(_ v: JSONValue) -> VoucherPublicKey {
        VoucherPublicKey(keyId: S.s(v["key"]?["keyId"]), nHex: S.s(v["key"]?["nHex"]), eHex: S.s(v["key"]?["eHex"]))
    }
    private func vouchers(_ v: JSONValue) -> [Voucher] { S.a(v["vouchers"]).map { Vouchers.parse($0)! } }
    private func filler(_ i: Int) -> Voucher {
        let h = String(i, radix: 16)
        return Voucher(k: "ffffffffffffffff", p: String(repeating: "00", count: 32), n: String(repeating: "0", count: 64 - h.count) + h, s: "AAAA")
    }

    func testEncodeByteForByte() throws {
        let v = try vectors()
        let vs = vouchers(v)
        XCTAssertEqual(S.s(v["path"]), VoucherLink.path)
        XCTAssertEqual(Int(S.i(v["maxPerLink"])), VoucherLink.maxPerLink)
        XCTAssertEqual(try VoucherLink.encodeLinks(Array(vs[0..<3]), apex: S.s(v["apex"])), S.a(v["links"]?["single"]).map { S.s($0) })
        XCTAssertEqual(try VoucherLink.encodeLinks(vs, apex: S.s(v["apex"])), S.a(v["links"]?["chunked"]).map { S.s($0) })
        XCTAssertEqual(try VoucherLink.encodePayload([vs[0]], part: 1, parts: 1), S.s(v["payloadOneVoucher"]))
    }

    func testParseCases() throws {
        let v = try vectors()
        for c in S.a(v["parse"]) {
            let name = S.s(c["name"])
            let e = c["expect"]!
            switch VoucherLink.parse(S.s(c["link"])) {
            case .success(let p):
                XCTAssertEqual(boolOf(e["ok"]), true, name)
                XCTAssertEqual(Int64(p.part), S.i(e["part"]), name)
                XCTAssertEqual(Int64(p.parts), S.i(e["parts"]), name)
                XCTAssertEqual(p.keyId, S.s(e["keyId"]), name)
                XCTAssertEqual(Int64(p.vouchers.count), S.i(e["count"]), name)
                XCTAssertEqual(p.vouchers.map(Vouchers.nullifier), S.a(e["nullifiers"]).map { S.s($0) }, name)
            case .failure(let err):
                XCTAssertEqual(boolOf(e["ok"]), false, name)
                XCTAssertEqual(err.rawValue, S.s(e["code"]), name)
            }
        }
    }

    func testChunkedRoundTrip() throws {
        let v = try vectors()
        let back = S.a(v["links"]?["chunked"]).flatMap { u -> [Voucher] in
            if case .success(let p) = VoucherLink.parse(S.s(u)) { return p.vouchers }
            return []
        }
        XCTAssertEqual(back, vouchers(v))
    }

    func testImportCases() throws {
        let v = try vectors()
        let vs = vouchers(v)
        let forged = Vouchers.parse(v["forged"])!
        let other = Vouchers.parse(v["otherKey"])!
        for c in S.a(v["imports"]) {
            let name = S.s(c["name"])
            var w = VoucherWallet.empty(overageCapUnits: 10)
            w.vouchers = S.a(c["wallet"]?["vouchers"]).map { vs[Int(S.i($0))] } + (0..<Int(c["wallet"]?["filler"]?.safeInt ?? 0)).map(filler)
            w.spent = S.a(c["wallet"]?["spent"]).map { Vouchers.nullifier(vs[Int(S.i($0))]) }
            let link: [Voucher] = S.a(c["link"]).map { r in
                if r.string == "forged" { return forged }
                if r.string == "otherKey" { return other }
                return vs[Int(S.i(r))]
            }
            let p = VoucherLink.planImport(wallet: w, vouchers: link, keys: S.s(c["keys"]) == "test" ? [key(v)] : [])
            let e = c["expect"]!
            XCTAssertEqual(p.add.map { a in Int64(vs.firstIndex { $0.n == a.n && $0.s == a.s } ?? -1) }, S.a(e["add"]).map { S.i($0) }, name)
            XCTAssertEqual(Int64(p.duplicate), S.i(e["duplicate"]), name)
            XCTAssertEqual(Int64(p.spent), S.i(e["spent"]), name)
            XCTAssertEqual(Int64(p.invalid), S.i(e["invalid"]), name)
            XCTAssertEqual(Int64(p.unknownKey), S.i(e["unknownKey"]), name)
            XCTAssertEqual(p.full, boolOf(e["full"]), name)
            XCTAssertEqual(p.outcome.rawValue, S.s(e["outcome"]), name)
        }
    }

    func testSecondOpenAddsNothing() throws {
        let v = try vectors()
        guard case .success(let link) = VoucherLink.parse(S.s(S.a(v["links"]?["single"])[0])) else { return XCTFail("vector link must parse") }
        let first = VoucherLink.planImport(wallet: .empty(overageCapUnits: 10), vouchers: link.vouchers, keys: [key(v)])
        let w = VoucherWalletSync.add(.empty(overageCapUnits: 10), first.add)
        let again = VoucherLink.planImport(wallet: w, vouchers: link.vouchers, keys: [key(v)])
        XCTAssertEqual(again.outcome, .already)
        XCTAssertTrue(again.add.isEmpty)
    }
}
