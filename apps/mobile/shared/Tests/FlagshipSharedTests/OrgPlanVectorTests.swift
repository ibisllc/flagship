import XCTest
@testable import FlagshipCore

/// Pins OrgPlan.swift, OrgWallet.swift, OrgPlanAttestation.swift and the Business half of PaymentsConfig.swift to
/// packages/protocol/test-vectors/org-plan/ (packages/protocol/tests/genOrgPlanVectors.ts; the TS replay is
/// orgPlanVectors.test.ts). The batch section is web-only and not ported.
final class OrgPlanVectorTests: XCTestCase {
    typealias S = VoiciVectorSupport

    private func vectors() throws -> JSONValue { try S.load("packages/protocol/test-vectors/org-plan/vectors.json", from: #filePath) }

    private func terms(_ v: JSONValue?) -> OrgPlanTerms {
        OrgPlanTerms(trialEndsAt: S.i(v?["trialEndsAt"]), trialSeats: S.i(v?["trialSeats"]), paidSeats: S.i(v?["paidSeats"]), paidUntil: S.i(v?["paidUntil"]))
    }

    private func wallet(_ v: JSONValue?) -> OrgVoucherWallet { OrgWalletSync.parse(v)! }

    func testConfigAndUnitLengths() throws {
        let v = try vectors()
        let cfg = PaymentsConfig.parse(v["config"])
        XCTAssertEqual(cfg, PaymentsConfig.defaults)
        XCTAssertEqual(cfg.orgSeatUnitMs(3), S.i(v["unitMs"]?["3"]))
        XCTAssertEqual(cfg.orgSeatUnitMs(10), S.i(v["unitMs"]?["10"]))
        XCTAssertEqual(cfg.orgMonthlyUnits(3), S.i(v["monthlyUnits"]?["3"]))
        XCTAssertEqual(cfg.orgMonthlyUnits(10), S.i(v["monthlyUnits"]?["10"]))
        XCTAssertFalse(cfg.isOrgSeatCount(2))
        XCTAssertTrue(cfg.isOrgSeatCount(3))
        XCTAssertEqual(PaymentsConfig.parse(["business": ["minSeats": 50, "maxSeats": 10]]).business, PaymentsConfig.defaults.business)
        XCTAssertEqual(PaymentsConfig.parse(["business": ["unitsPerSeatMonth": -1]]).business.unitsPerSeatMonth, 6)
        let c = PaymentsConfig.parse(["business": ["unitsPerSeatMonth": 8, "minSeats": 5, "trialDays": 14]])
        XCTAssertEqual([c.business.unitsPerSeatMonth, c.business.minSeats, c.business.trialDays, c.business.trialSeats], [8, 5, 14, 10])
    }

    func testStateSpendTrickleEgress() throws {
        let v = try vectors()
        let cfg = PaymentsConfig.defaults
        for (i, c) in S.a(v["state"]).enumerated() {
            let st = OrgPlan.state(cfg, terms(c["terms"]), now: S.i(c["now"]))
            let out = c["out"]
            XCTAssertEqual(st.terms, terms(out), S.s(c["name"]))
            XCTAssertEqual(st.status.rawValue, S.s(out?["status"]), S.s(c["name"]))
            XCTAssertEqual(st.seatLimit, S.i(out?["seatLimit"]), S.s(c["name"]))
            XCTAssertEqual(st.coveredUntil, S.i(out?["coveredUntil"]), S.s(c["name"]))
            let egress = S.a(v["egress"])[i]["out"]
            XCTAssertEqual(OrgPlan.egressGb(cfg, st), egress?.isNull == true ? nil : S.i(egress), S.s(c["name"]))
        }
        for c in S.a(v["spend"]) {
            let t = terms(c["terms"])
            XCTAssertEqual(OrgPlan.paidUntilAfterSpend(cfg, t, seats: S.i(c["seats"]), n: S.i(c["n"]), now: S.i(c["now"])), S.i(c["out"]), S.s(c["name"]))
            XCTAssertEqual(OrgPlan.aheadMs(cfg, t, seats: S.i(c["seats"]), now: S.i(c["now"])), S.i(c["ahead"]), S.s(c["name"]))
        }
        for c in S.a(v["trickle"]) {
            let i = c["input"]
            let input = OrgPlan.TrickleInput(now: S.i(i?["now"]), enabled: i?["enabled"] == .bool(true), balance: S.i(i?["balance"]),
                                             terms: terms(i?["terms"]), seats: S.i(i?["seats"]), nextSpendAt: S.i(i?["nextSpendAt"]))
            let out = OrgPlan.trickleStep(cfg, input, rand: c["rand"]!.number!)
            XCTAssertEqual(out.spend, S.i(c["out"]?["spend"]), S.s(c["name"]))
            XCTAssertEqual(out.nextSpendAt, S.i(c["out"]?["nextSpendAt"]), S.s(c["name"]))
        }
    }

    func testSeatCountChangeKeepsValue() {
        let cfg = PaymentsConfig.defaults
        let now: Int64 = 1_000_000_000_000
        let t = OrgPlanTerms(trialEndsAt: now - 1, trialSeats: 10, paidSeats: 3, paidUntil: now + 6 * 86_400_000)
        XCTAssertEqual(OrgPlan.paidUntilAfterSpend(cfg, t, seats: 6, n: 0, now: now) - now, 3 * 86_400_000)
    }

    func testAttestation() throws {
        let a = try vectors()["attestation"]!
        let signed = try XCTUnwrap(OrgPlanAttestation.parse(a["signed"]))
        XCTAssertEqual(S.text(try signed.canonical()), S.s(a["canonical"]))
        XCTAssertEqual(signed.signedBy, S.s(a["caPubHex"]))
        let issued = S.i(a["body"]?["issuedAt"])
        XCTAssertTrue(signed.verify(pubkeyHex: S.s(a["caPubHex"]), now: issued + 1))
        XCTAssertFalse(signed.verify(pubkeyHex: S.s(a["caPubHex"]), now: S.i(a["body"]?["expiresAt"])), "expired")
        XCTAssertFalse(signed.verify(pubkeyHex: String(repeating: "ab", count: 32), now: issued + 1), "another key")
        var forged = signed
        forged.seatLimit += 1
        XCTAssertFalse(forged.verify(pubkeyHex: S.s(a["caPubHex"]), now: issued + 1))
        guard case .object(var o) = a["signed"]! else { return XCTFail() }
        o["status"] = "free"
        XCTAssertNil(OrgPlanAttestation.parse(.object(o)))
        o["status"] = "paid"; o["orgId"] = "ab"
        XCTAssertNil(OrgPlanAttestation.parse(.object(o)))
    }

    func testVoucherFiles() throws {
        let v = try vectors()
        let vouchers = S.a(v["batch"]?["vouchers"]).map { Vouchers.parse($0)! }
        XCTAssertEqual(try VoucherFiles.text(vouchers), S.s(v["voucherFile"]?["text"]))
        XCTAssertEqual(try VoucherFiles.text(vouchers.reversed() + vouchers), S.s(v["voucherFile"]?["text"]))
        XCTAssertEqual(VoucherFiles.id(S.s(v["voucherFile"]?["text"])), S.s(v["voucherFile"]?["id"]))
        XCTAssertEqual(try VoucherFiles.split(vouchers, perFile: 2), S.a(v["voucherFile"]?["split2"]).map { S.s($0) })
        XCTAssertThrowsError(try VoucherFiles.text([]))
    }

    func testWalletSealOpenWriteMerge() throws {
        let w = try vectors()["wallet"]!
        let orgId = S.s(w["orgId"])
        let key = try OrgWalletSync.deriveKey(ringKey: S.h(w["ringKeyHex"]), orgId: orgId)
        XCTAssertEqual(CanonicalJson.hex(key), S.s(w["keyHex"]))
        let plain = wallet(w["wallet"])
        let text = try OrgWalletSync.plaintext(plain)
        XCTAssertEqual(text, S.s(w["plaintext"]))
        XCTAssertEqual(Int64(text.utf8.count), S.i(w["plaintextLength"]))
        let sealed = try OrgWalletSync.seal(key: key, orgId: orgId, keyVersion: S.i(w["keyVersion"]), version: S.i(w["version"]), wallet: plain,
                                            nonce: S.h(w["nonceHex"]))
        XCTAssertEqual(sealed.json, w["sealed"])
        XCTAssertEqual(OrgWalletSync.open(key: key, orgId: orgId, blob: w["sealed"]), plain)
        XCTAssertNil(OrgWalletSync.open(key: key, orgId: String(repeating: "1f", count: 16), blob: w["sealed"]))
        var bumped = sealed; bumped.version += 1
        XCTAssertNil(OrgWalletSync.open(key: key, orgId: orgId, blob: bumped.json))
        var rekeyed = sealed; rekeyed.keyVersion = 3
        XCTAssertNil(OrgWalletSync.open(key: key, orgId: orgId, blob: rekeyed.json))
        XCTAssertNil(OrgWalletSync.parseSealed(["version": 1, "keyVersion": 1, "nonce": "00", "ct": "AAAA"]))
        XCTAssertEqual(OrgWalletSync.blobSha256(sealed), S.s(w["blobSha256"]))
        let write = OrgWalletSync.writeFor(orgId: orgId, blob: sealed, issuedAt: S.i(w["write"]?["issuedAt"]))
        XCTAssertEqual(write.json, w["write"])
        XCTAssertEqual(S.text(try OrgWalletSync.canonicalWrite(write)), S.s(w["writeCanonical"]))
        XCTAssertTrue(S.s(w["writeCanonical"]).hasPrefix(OrgWalletSync.writeTag + "|"))
        let m = try vectors()["merge"]!
        XCTAssertEqual(OrgWalletSync.merge(local: wallet(m["local"]), remote: wallet(m["remote"])), wallet(m["merged"]))
    }

    func testEmptyWalletRoundTrip() throws {
        let key = [UInt8](repeating: 1, count: 32)
        let w = OrgVoucherWallet.empty(seats: 3, overageCapUnits: 10)
        let s = try OrgWalletSync.seal(key: key, orgId: String(repeating: "ab", count: 16), keyVersion: 1, version: 1, wallet: w)
        XCTAssertEqual(OrgWalletSync.open(key: key, orgId: String(repeating: "ab", count: 16), sealed: s), w)
    }

    func testWalletKeyKindIsOrgWideAndAdminsOnly() {
        XCTAssertEqual(OrgKeyKind(rawValue: "wallet"), .wallet)
        XCTAssertTrue(OrgRotation.orgWide(.wallet))
        XCTAssertTrue(OrgAuthority.orgWide(.wallet))
    }
}
