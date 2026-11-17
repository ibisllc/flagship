import XCTest
import FlagshipAPI
import FlagshipCore
@testable import FlagshipUI

/// The org Plan on the phone: a store pack bought for an org lands in the org's wallet (not the account's) before the
/// purchase is finished, a purchase for an org this phone hasn't opened waits, and the screen's sentences.
@MainActor
final class OrgPlanTests: XCTestCase {
    private var clock: Int64 = 1_795_000_000_000
    private let orgId = String(repeating: "0f", count: 16)
    private let device: VoiciDeviceSigner = { _, _ in
        AccountDirectoryAuthorization(deviceId: "d1", signerPubHex: String(repeating: "a", count: 64), requestId: "r", issuedAt: 1, signatureHex: "s")
    }

    override func tearDown() {
        OrgVoucherSinks.forgetAll()
        super.tearDown()
    }

    private func center(_ store: MockVoucherStore) async -> (PaymentsCenter, MockPaymentsComClient) {
        let mock = MockPaymentsComClient()
        mock.now = { [unowned self] in self.clock }
        let device = self.device
        let c = PaymentsCenter(defaults: UserDefaults(suiteName: UUID().uuidString)!, context: { u in
            .init(username: u, isAdmin: true, umk: { [UInt8](repeating: 7, count: 32) }, device: device)
        }, store: store, vault: MemoryShopVault())
        c.now = { [unowned self] in self.clock }
        c.shop?.destinations = UserDefaults(suiteName: UUID().uuidString)!
        c.configure(client: mock, username: "plucky-avocet", deviceId: "d1")
        await c.refreshAndTick()
        return (c, mock)
    }

    private func orgModel(_ state: OrgPlanStatus, admin: Bool = true) async -> (OrgPlanModel, MockOrgPaymentsComClient) {
        let com = MockOrgPaymentsComClient()
        com.now = { [unowned self] in self.clock }
        com.seed(orgId: orgId, state: state, liveSeats: 4, now: clock)
        let m = OrgPlanModel(fixtureOrgId: orgId, orgName: "acme", isOrgAdmin: admin, payments: com, now: { [unowned self] in self.clock })
        await m.load(interactive: true)
        return (m, com)
    }

    func testAPackBoughtForTheOrgGoesIntoTheOrgWallet() async throws {
        let store = MockVoucherStore()
        let (c, personal) = await center(store)
        let (m, com) = await orgModel(.trial)
        XCTAssertTrue(m.hasKey)
        let ok = await c.shop!.buy(units: 10, orgId: orgId)
        XCTAssertTrue(ok)
        XCTAssertEqual(c.shop?.outcome?.code, "added")
        XCTAssertEqual(c.balanceUnits, 0, "Not the account's balance.")
        XCTAssertNil(personal.wallets["plucky-avocet"], "Nothing was written to the account's wallet.")
        await m.load(interactive: false)
        XCTAssertEqual(m.balanceUnits, 10)
        XCTAssertEqual(com.writes.count, 1)
        XCTAssertEqual(store.finished.count, 1)
    }

    func testAPurchaseForAnOrgNotOpenWaits() async throws {
        let store = MockVoucherStore()
        let (c, _) = await center(store)
        let ok = await c.shop!.buy(units: 10, orgId: orgId)
        XCTAssertFalse(ok)
        XCTAssertEqual(c.shop?.outcome?.code, "no-device-key")
        XCTAssertTrue(store.purchases.isEmpty, "Nothing is bought for an org whose wallet this phone can't open.")
    }

    func testMemberSeesThePlanButCantBuy() async throws {
        let store = MockVoucherStore()
        let (c, _) = await center(store)
        let (m, _) = await orgModel(.paid, admin: false)
        XCTAssertEqual(m.plan?.status, .paid)
        XCTAssertFalse(m.hasKey)
        let ok = await c.shop!.buy(units: 10, orgId: orgId)
        XCTAssertFalse(ok)
    }

    func testGymCreditPaysALapsedOrgBackToPaid() async throws {
        let (m, com) = await orgModel(.lapsed)
        XCTAssertEqual(m.plan?.status, .lapsed)
        let ok = await m.addFixtureVouchers(30)
        XCTAssertTrue(ok)
        XCTAssertEqual(m.plan?.status, .paid)
        XCTAssertEqual(com.redeems.first?.seats, 4)
    }

    func testSeatStepperFloor() async throws {
        let (m, _) = await orgModel(.trial)
        XCTAssertEqual(m.seats, 4)
        await m.setSeats(2)
        XCTAssertEqual(m.seats, 4)
        await m.setSeats(7)
        XCTAssertEqual(m.seats, 7)
    }

    func testSentences() {
        let cfg = PaymentsConfig.defaults
        XCTAssertEqual(OrgPlanDisplay.price(cfg, seats: 3), "$6 a seat a month: $18 a month")
        var priced = cfg
        priced.business.unitsPerSeatMonth = 8
        XCTAssertEqual(OrgPlanDisplay.price(priced, seats: 3), "$8 a seat a month: $24 a month", "Served numbers, never hard-coded.")
        XCTAssertEqual(OrgPlanDisplay.covers(cfg, balance: 36, seats: 3), "About 2 months at this seat count")
        XCTAssertEqual(OrgPlanDisplay.daysLeft(until: clock + 86_400_000 + 1, now: clock), 2)
        XCTAssertEqual(OrgPlanDisplay.daysLeft(until: clock - 1, now: clock), 0)
        let trial = OrgPlanServed(orgId: orgId, status: .trial, seatLimit: 10, paidSeats: 0, paidUntil: 0, trialEndsAt: clock + 5 * 86_400_000,
                                  coveredUntil: 0, liveSeats: 2, unitsPerSeatMonth: 6, minSeats: 3, maxSeats: 10_000, unitUsd: 1)
        XCTAssertEqual(OrgPlanDisplay.status(trial, now: clock), "Business, trial: 5 days left")
        XCTAssertEqual(OrgPlanDisplay.seatsInUse(trial), "2 of 10")
        var lapsed = trial
        lapsed.status = .lapsed
        XCTAssertEqual(OrgPlanDisplay.status(lapsed, now: clock), "Business has lapsed")
        XCTAssertEqual(OrgPlanDisplay.error("org-plan-lapsed"), "This org's plan has lapsed. Pay for seats on the Plan to add people.")
        XCTAssertEqual(OrgPlanDisplay.error("org-not-admin"), "Only an organization admin can change the organization's balance.")
    }

    func testServedPlanParses() {
        let p = OrgPlanServed.parse(["orgId": .string(orgId), "status": "paid", "seatLimit": 5, "paidSeats": 5, "paidUntil": 1_800_000_000_000,
                                     "trialEndsAt": 1_700_000_000_000, "coveredUntil": 1_800_000_000_000, "liveSeats": 4,
                                     "price": ["unitsPerSeatMonth": 7, "minSeats": 3, "maxSeats": 100, "unitUsd": 1]])
        XCTAssertEqual(p?.status, .paid)
        XCTAssertEqual(p?.config(.defaults).business.unitsPerSeatMonth, 7)
        XCTAssertEqual(p?.config(.defaults).business.maxSeats, 100)
        XCTAssertNil(OrgPlanServed.parse(["orgId": .string(orgId), "status": "free"]))
    }
}
