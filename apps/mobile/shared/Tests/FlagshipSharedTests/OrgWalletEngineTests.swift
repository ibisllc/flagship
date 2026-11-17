import XCTest
import FlagshipAPI
@testable import FlagshipCore

/// The org wallet engine against the in-memory `.com` (MockOrgPaymentsComClient): bought vouchers into the org wallet,
/// sync between two org admins, the org trickle, the seat floor, and the exchange after a `wallet` key rotation.
@MainActor
final class OrgWalletEngineTests: XCTestCase {
    let orgId = String(repeating: "0f", count: 16)
    var clock: Int64 = 1_795_000_000_000
    var ring: [Int64: [UInt8]] = [1: [UInt8](repeating: 0x11, count: 32)]
    var unlocked = true

    private func mock(_ state: OrgPlanStatus, live: Int64 = 3) -> MockOrgPaymentsComClient {
        let m = MockOrgPaymentsComClient()
        m.now = { [unowned self] in self.clock }
        m.payments.now = { [unowned self] in self.clock }
        m.seed(orgId: orgId, state: state, liveSeats: live, now: clock)
        return m
    }

    private func engine(_ m: MockOrgPaymentsComClient, admin: Bool = true, rand: Double = 0.5) -> OrgWalletEngine {
        let e = OrgWalletEngine(client: m, context: .init(
            orgId: orgId, isOrgAdmin: admin, ringKeys: { [unowned self] in self.ring }, canApprove: { [unowned self] in self.unlocked },
            approve: { [unowned self] order in self.unlocked ? ["orderSha256": .string(CanonicalJson.sha256Hex(order))] : nil }),
            defaults: UserDefaults(suiteName: UUID().uuidString)!)
        e.now = { [unowned self] in self.clock }
        e.random = { rand }
        return e
    }

    func testBoughtVouchersLandInTheOrgWalletAndSync() async throws {
        let m = mock(.trial)
        let a = engine(m)
        await a.refresh()
        XCTAssertEqual(a.plan?.status, .trial)
        XCTAssertEqual(a.balance, 0)
        let added = await a.addBought(try m.payments.makeVouchers(18))
        XCTAssertTrue(added)
        XCTAssertEqual(a.balance, 18)
        XCTAssertEqual(m.writes.count, 1)
        XCTAssertEqual(m.writes[0].write.blobSha256, OrgWalletSync.blobSha256(OrgWalletSync.parseSealed(m.orgs[orgId]?.wallet)!))
        let b = engine(m)
        await b.refresh()
        XCTAssertEqual(b.balance, 18)
        XCTAssertEqual(b.wallet?.settings.seats, 3)
    }

    func testNonAdminSeesThePlanButNoWallet() async throws {
        let m = mock(.paid)
        let a = engine(m, admin: false)
        await a.refresh()
        XCTAssertEqual(a.plan?.status, .paid)
        XCTAssertNil(a.wallet)
        XCTAssertFalse(a.canSpend)
        let added = await a.addBought(try m.payments.makeVouchers(1))
        XCTAssertFalse(added)
    }

    func testTrialWellAheadSpendsNothing() async throws {
        let m = mock(.trial)
        let a = engine(m)
        await a.refresh()
        await a.addBought(try m.payments.makeVouchers(20))
        await a.tick()
        XCTAssertTrue(m.redeems.isEmpty)
        XCTAssertEqual(a.balance, 20)
    }

    func testLapsedOrgTricklesBackToPaid() async throws {
        let m = mock(.lapsed, live: 4)
        let a = engine(m)
        await a.refresh()
        XCTAssertEqual(a.plan?.status, .lapsed)
        XCTAssertEqual(a.minSeats, 4)
        await a.addBought(try m.payments.makeVouchers(30))
        await a.tick()
        XCTAssertEqual(m.redeems.first?.seats, 4, "the wallet pays for at least the live seats")
        XCTAssertEqual(a.plan?.status, .paid)
        XCTAssertGreaterThan(a.plan?.paidUntil ?? 0, clock)
        XCTAssertEqual(a.balance, 30 - (m.redeems.first?.count ?? 0))
        let lead = OrgPlan.aheadMs(a.config, a.plan!.terms, seats: 4, now: clock)
        XCTAssertGreaterThanOrEqual(lead, a.config.trickle.lowWaterDays * 86_400_000)
    }

    func testSeatStepperStaysAboveTheFloor() async throws {
        let m = mock(.paid, live: 5)
        let a = engine(m)
        await a.refresh()
        await a.addBought(try m.payments.makeVouchers(1))
        let ok = await a.setSeats(2)
        XCTAssertTrue(ok)
        XCTAssertEqual(a.wallet?.settings.seats, 5)
        await a.setSeats(9)
        XCTAssertEqual(a.wallet?.settings.seats, 9)
    }

    func testConcurrentWritesMerge() async throws {
        let m = mock(.trial)
        let a = engine(m), b = engine(m)
        await a.refresh(); await b.refresh()
        await a.addBought(try m.payments.makeVouchers(2))
        let ok = await b.addBought(try m.payments.makeVouchers(3))
        XCTAssertTrue(ok)
        XCTAssertEqual(b.balance, 5)
        XCTAssertEqual(OrgWalletSync.parseSealed(m.orgs[orgId]?.wallet)?.version, 2)
    }

    func testLockedSessionWritesNothing() async throws {
        let m = mock(.trial)
        let a = engine(m)
        await a.refresh()
        unlocked = false
        let added = await a.addBought(try m.payments.makeVouchers(2))
        XCTAssertFalse(added)
        XCTAssertTrue(m.writes.isEmpty)
    }

    func testRotationExchangesEveryVoucher() async throws {
        let m = mock(.trial)
        let a = engine(m)
        await a.refresh()
        let before = try m.payments.makeVouchers(35)
        await a.addBought(before)
        ring[2] = [UInt8](repeating: 0x22, count: 32)
        let b = engine(m)
        await b.refresh()
        XCTAssertTrue(b.needsRekey)
        XCTAssertEqual(b.balance, 35)
        let ok = await b.rekey()
        XCTAssertTrue(ok)
        XCTAssertEqual(m.exchanges, 2, "30 a request")
        XCTAssertEqual(b.balance, 35)
        XCTAssertTrue(Set(b.wallet!.vouchers).isDisjoint(with: Set(before)))
        XCTAssertEqual(OrgWalletSync.parseSealed(m.orgs[orgId]?.wallet)?.keyVersion, 2)
        XCTAssertFalse(b.needsRekey)
        ring[1] = nil
        let c = engine(m)
        await c.refresh()
        XCTAssertEqual(c.balance, 35, "the new key alone opens it")
    }

    func testRefusalsComeBackAsCodes() async throws {
        let m = mock(.lapsed, live: 3)
        m.refuseWrites = "org-not-admin"
        let a = engine(m)
        await a.refresh()
        let added = await a.addBought(try m.payments.makeVouchers(1))
        XCTAssertFalse(added)
        XCTAssertEqual(a.lastError, "org-not-admin")
    }
}
