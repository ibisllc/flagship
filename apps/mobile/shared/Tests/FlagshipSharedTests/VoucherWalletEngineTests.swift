import XCTest
import FlagshipAPI
@testable import FlagshipCore

/// The phone's wallet engine against the in-memory `.com` (MockPaymentsComClient): sync between two admin devices,
/// the trickle, overage, a delayed start, and the refusals `.com` answers with.
@MainActor
final class VoucherWalletEngineTests: XCTestCase {
    let umk = [UInt8](repeating: 0x42, count: 32)
    let device: VoiciDeviceSigner = { _, _ in AccountDirectoryAuthorization(deviceId: "d1", signerPubHex: String(repeating: "a", count: 64), requestId: "r", issuedAt: 1, signatureHex: "s") }
    var clock: Int64 = 1_795_000_000_000

    private func engine(_ mock: MockPaymentsComClient, admin: Bool = true, rand: Double = 0.5) -> VoucherWalletEngine {
        let key = self.umk
        let e = VoucherWalletEngine(client: mock, context: .init(username: "plucky-avocet", isAdmin: admin, umk: { key }, device: device),
                                    defaults: UserDefaults(suiteName: UUID().uuidString)!)
        e.now = { [unowned self] in self.clock }
        e.random = { rand }
        return e
    }

    private func mock() -> MockPaymentsComClient {
        let m = MockPaymentsComClient()
        m.now = { [unowned self] in self.clock }
        return m
    }

    func testTestVouchersSyncToAnotherDevice() async {
        let m = mock()
        let a = engine(m)
        await a.refresh()
        XCTAssertEqual(a.balance, 0)
        let added = await a.addTestVouchers(30)
        XCTAssertTrue(added)
        XCTAssertEqual(a.balance, 30)
        XCTAssertEqual(VoucherWalletSync.version(m.wallets["plucky-avocet"]), 1)
        let b = engine(m)
        await b.refresh()
        XCTAssertEqual(b.balance, 30)
    }

    func testChoosingProSpendsAtOnceThenTrickles() async {
        let m = mock()
        let a = engine(m)
        await a.refresh()
        await a.addTestVouchers(30)
        let chosen = await a.choosePlan(.pro, delayStart: false)
        XCTAssertTrue(chosen)
        XCTAssertEqual(a.planState.plan, .pro)
        XCTAssertEqual(a.planState.paidUntil, clock + PaymentsConfig.defaults.unitMs(.pro))
        XCTAssertEqual(a.balance, 29)
        // Ahead 3 days: inside the window, so the next spend is scheduled (rand 0.5 → 1.5 days later).
        XCTAssertEqual(a.nextSpendAt, clock + PaymentsConfig.defaults.unitMs(.pro) / 2)
        clock = a.nextSpendAt
        await a.refresh()
        await a.tick()
        // Lead fell under 3 days: catch-up spends one at once.
        XCTAssertEqual(a.balance, 28)
        XCTAssertEqual(m.redeems.count, 2)
    }

    func testDelayedStartWaits() async {
        let m = mock()
        let a = engine(m)
        await a.refresh()
        await a.addTestVouchers(10)
        await a.choosePlan(.proMax, delayStart: true)
        XCTAssertEqual(a.wallet?.settings.startAt, clock + 12 * 3_600_000)
        XCTAssertEqual(a.balance, 10)
        XCTAssertNil(a.planState.plan)
        clock += 13 * 3_600_000
        await a.tick()
        XCTAssertEqual(a.planState.plan, .proMax)
        XCTAssertEqual(a.balance, 8)
    }

    func testSpentElsewhereIsDroppedAndRetried() async throws {
        let m = mock()
        let a = engine(m)
        await a.refresh()
        await a.addTestVouchers(5)
        await a.choosePlan(.pro, delayStart: false)
        XCTAssertEqual(a.balance, 4)
        // Another device spent the voucher this one would take next, and hasn't synced yet.
        let next = VoucherWalletSync.take(try XCTUnwrap(a.wallet), 1)
        _ = try await m.redeem(username: "plucky-avocet", for: "pro", vouchers: next)
        clock += 2 * 86_400_000
        await a.tick()
        XCTAssertEqual(m.nullifiers.count, 3)
        XCTAssertEqual(a.balance, 2)
        XCTAssertNil(a.lastError)
    }

    func testOverageBlockWithinCap() async {
        let m = mock()
        let a = engine(m)
        await a.refresh()
        await a.addTestVouchers(20)
        await a.choosePlan(.pro, delayStart: false)
        m.usedBytes["plucky-avocet"] = 245 * 1_073_741_824
        await a.refresh()
        await a.tick()
        XCTAssertEqual(m.topUps["plucky-avocet"], 100 * 1_073_741_824)
        XCTAssertEqual(a.wallet?.overage.units, 5)
        m.usedBytes["plucky-avocet"] = 345 * 1_073_741_824
        await a.refresh()
        await a.tick()
        XCTAssertEqual(a.wallet?.overage.units, 10)
        // The default cap is 10: a third block waits for next month.
        m.usedBytes["plucky-avocet"] = 445 * 1_073_741_824
        await a.refresh()
        await a.tick()
        XCTAssertEqual(a.wallet?.overage.units, 10)
    }

    func testNonAdminNeverSpends() async {
        let m = mock()
        let a = engine(m)
        await a.refresh()
        await a.addTestVouchers(5)
        let viewer = engine(m, admin: false)
        await viewer.refresh()
        XCTAssertFalse(viewer.canSpend)
        let chosen = await viewer.choosePlan(.pro, delayStart: false)
        XCTAssertFalse(chosen)
        XCTAssertTrue(m.redeems.isEmpty)
    }

    func testRedeemRefusals() async throws {
        let m = mock()
        let vs = try m.makeVouchers(6)
        let r = try await m.redeem(username: "u1", for: "pro", vouchers: Array(vs.prefix(2)))
        XCTAssertEqual(r.credited, 2)
        do { _ = try await m.redeem(username: "u1", for: "pro", vouchers: Array(vs.prefix(2))); XCTFail() } catch let e as PaymentsComError {
            XCTAssertEqual(e.code, "voucher-spent")
            XCTAssertEqual(e.spent.count, 2)
        }
        do { _ = try await m.redeem(username: "u2", for: "overage", vouchers: Array(vs.suffix(4))); XCTFail() } catch let e as PaymentsComError {
            XCTAssertEqual(e.code, "overage-needs-plan")
        }
        var bad = vs[5]
        bad.n = String(repeating: "0", count: 64)
        do { _ = try await m.redeem(username: "u1", for: "pro", vouchers: [bad]); XCTFail() } catch let e as PaymentsComError {
            XCTAssertEqual(e.code, "bad-voucher")
        }
    }
}

