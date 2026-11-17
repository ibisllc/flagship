import XCTest
@testable import FlagshipCore

/// Pins Vouchers.swift, PaymentsConfig.swift and VoucherWallet.swift to packages/protocol/test-vectors/vouchers/
/// (packages/protocol/tests/genVoucherVectors.ts; the TS replay is voucherVectors.test.ts).
final class VoucherVectorTests: XCTestCase {
    typealias S = VoiciVectorSupport

    private func vectors() throws -> JSONValue { try S.load("packages/protocol/test-vectors/vouchers/vectors.json", from: #filePath) }

    private func key(_ v: JSONValue) -> VoucherPublicKey {
        VoucherPublicKey(keyId: S.s(v["key"]?["keyId"]), nHex: S.s(v["key"]?["nHex"]), eHex: S.s(v["key"]?["eHex"]))
    }

    private func voucher(_ j: JSONValue?) -> Voucher { Vouchers.parse(j)! }

    func testKeyId() throws {
        let v = try vectors()
        let k = key(v)
        XCTAssertEqual(Vouchers.keyId(nHex: k.nHex, eHex: k.eHex), k.keyId)
        XCTAssertTrue(Vouchers.isUsableKey(k))
        XCTAssertFalse(Vouchers.isUsableKey(VoucherPublicKey(keyId: String(repeating: "0", count: 16), nHex: k.nHex, eHex: k.eHex)))
    }

    func testBlindFinalizeVerify() throws {
        let v = try vectors()
        let k = key(v)
        for c in S.a(v["blind"]) {
            let req = try Vouchers.newRequest(key: k, nonce: S.h(c["nonceHex"]), prefix: S.h(c["prefixHex"]), salt: S.h(c["saltHex"]), rHex: S.s(c["rHex"]))
            XCTAssertEqual(req.blinded, S.s(c["blinded"]))
            XCTAssertEqual(req.pending.inv, S.s(c["invHex"]))
            let out = try Vouchers.finalize(key: k, pending: req.pending, blindSig: S.s(c["blindSig"]))
            XCTAssertEqual(out, voucher(c["voucher"]))
            XCTAssertEqual(Vouchers.preparedHex(out), S.s(c["preparedHex"]))
            XCTAssertEqual(CanonicalJson.hex(Vouchers.message(nonce: S.h(c["nonceHex"]))), S.s(c["messageHex"]))
            XCTAssertEqual(Vouchers.nullifier(out), S.s(c["nullifier"]))
            XCTAssertTrue(Vouchers.verify(key: k, voucher: out))
        }
    }

    func testRandomRequestRoundTripsShape() throws {
        let v = try vectors()
        let req = try Vouchers.newRequest(key: key(v))
        XCTAssertEqual(CanonicalJson.b64Decode(req.blinded)?.count, 256)
        // A signature for another request doesn't finalize.
        XCTAssertThrowsError(try Vouchers.finalize(key: key(v), pending: req.pending, blindSig: S.s(S.a(v["blind"])[0]["blindSig"])))
    }

    func testBadVouchersRefused() throws {
        let v = try vectors()
        for b in S.a(v["bad"]) {
            if let p = Vouchers.parse(b["voucher"]) { XCTAssertFalse(Vouchers.verify(key: key(v), voucher: p), S.s(b["why"])) }
        }
    }

    private func wallet(_ j: JSONValue?) -> VoucherWallet { VoucherWalletSync.parse(j)! }

    func testWalletSeal() throws {
        let w = try XCTUnwrap(try vectors()["wallet"])
        let k = VoucherWalletSync.deriveKey(umk: S.h(w["umkSeedHex"]))
        XCTAssertEqual(CanonicalJson.hex(k), S.s(w["keyHex"]))
        let wal = wallet(w["wallet"])
        let pt = try VoucherWalletSync.plaintext(wal)
        XCTAssertEqual(pt, S.s(w["plaintext"]))
        XCTAssertEqual(Int64(pt.utf8.count), S.i(w["plaintextLength"]))
        let sealed = try VoucherWalletSync.seal(key: k, version: S.i(w["version"]), wallet: wal, nonce: S.h(w["nonceHex"]))
        XCTAssertEqual(sealed, w["sealed"])
        XCTAssertEqual(VoucherWalletSync.open(key: k, blob: w["sealed"]), VoucherWalletSync.normalize(wal))
        var other = w["sealed"]!.object!
        other["version"] = .int(S.i(w["version"]) + 1)
        XCTAssertNil(VoucherWalletSync.open(key: k, blob: .object(other)))
    }

    func testMerge() throws {
        let m = try XCTUnwrap(try vectors()["merge"])
        let merged = wallet(m["merged"])
        XCTAssertEqual(VoucherWalletSync.merge(local: wallet(m["local"]), remote: wallet(m["remote"])), merged)
        XCTAssertEqual(VoucherWalletSync.merge(local: wallet(m["remote"]), remote: wallet(m["local"])), merged)
    }

    func testSpendingRules() throws {
        let v = try vectors()
        let cfg = PaymentsConfig.parse(v["defaultConfig"])
        XCTAssertEqual(cfg, PaymentsConfig.defaults)
        XCTAssertEqual(cfg.unitMs(.pro), S.i(v["unitMs"]?["pro"]))
        XCTAssertEqual(cfg.unitMs(.proMax), S.i(v["unitMs"]?["pro-max"]))
        for c in S.a(v["trickle"]) {
            let i = c["input"]!
            let input = VoucherSpending.TrickleInput(
                now: S.i(i["now"]), enabled: i["enabled"] == .bool(true), balance: S.i(i["balance"]), aheadMs: S.i(i["aheadMs"]),
                startAt: S.i(i["startAt"]), nextSpendAt: S.i(i["nextSpendAt"]), unitMs: S.i(i["unitMs"]), lowWaterMs: S.i(i["lowWaterMs"]),
                highWaterMs: S.i(i["highWaterMs"]), maxPerRequest: S.i(i["maxPerRequest"]))
            let out = VoucherSpending.trickleStep(input, rand: c["rand"]!.number!)
            XCTAssertEqual(out.spend, S.i(c["out"]?["spend"]), S.s(c["name"]))
            XCTAssertEqual(out.nextSpendAt, S.i(c["out"]?["nextSpendAt"]), S.s(c["name"]))
        }
        for c in S.a(v["overage"]) {
            let i = c["input"]!
            let input = VoucherSpending.OverageInput(paid: i["paid"] == .bool(true), remainingBytes: S.i(i["remainingBytes"]), buyBelowBytes: S.i(i["buyBelowBytes"]),
                                                     capUnits: S.i(i["capUnits"]), spentUnits: S.i(i["spentUnits"]), blockUnits: S.i(i["blockUnits"]),
                                                     balance: S.i(i["balance"]))
            XCTAssertEqual(VoucherSpending.overageStep(input), c["out"] == .bool(true), S.s(c["name"]))
        }
        for c in S.a(v["planAhead"]) {
            let paid = VoucherSpending.PaidState(plan: c["paid"]?["plan"]?.string.flatMap(PaidPlan.init(rawValue:)), paidUntil: S.i(c["paid"]?["paidUntil"]))
            let plan = PaidPlan(rawValue: S.s(c["plan"]))!
            XCTAssertEqual(VoucherSpending.planAheadMs(cfg, plan: plan, paid: paid, now: S.i(c["now"])), S.i(c["out"]), S.s(c["name"]))
        }
    }

    func testWalletOperations() throws {
        let v = try vectors()
        var w = VoucherWalletSync.add(.empty(overageCapUnits: 10), S.a(v["blind"]).map { voucher($0["voucher"]) })
        XCTAssertEqual(w.balance, 3)
        let first = VoucherWalletSync.take(w, 1)[0]
        w = VoucherWalletSync.markSpent(w, [Vouchers.nullifier(first)])
        XCTAssertEqual(w.balance, 2)
        w = VoucherWalletSync.add(w, [first])
        XCTAssertEqual(w.balance, 2)
        XCTAssertEqual(VoucherSpending.overagePeriod(1_763_400_000_000), "2025-11")
    }
}
