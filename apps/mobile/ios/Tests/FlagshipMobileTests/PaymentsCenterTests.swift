import XCTest
import FlagshipAPI
import FlagshipCore
@testable import FlagshipUI

/// The Plan screen's model (PaymentsCenter) over the in-memory `.com`, and its display rules.
@MainActor
final class PaymentsCenterTests: XCTestCase {
    private var clock: Int64 = 1_795_000_000_000
    private let device: VoiciDeviceSigner = { _, _ in
        AccountDirectoryAuthorization(deviceId: "d1", signerPubHex: String(repeating: "a", count: 64), requestId: "r", issuedAt: 1, signatureHex: "s")
    }

    private func center(admin: Bool = true, key: Bool = true) -> (PaymentsCenter, MockPaymentsComClient) {
        let m = MockPaymentsComClient()
        m.now = { [unowned self] in self.clock }
        let device = self.device
        let c = PaymentsCenter(defaults: UserDefaults(suiteName: UUID().uuidString)!) { u in
            .init(username: u, isAdmin: admin, umk: { key ? [UInt8](repeating: 7, count: 32) : nil }, device: key ? device : nil)
        }
        c.now = { [unowned self] in self.clock }
        c.random = { 0.25 }
        c.configure(client: m, username: "plucky-avocet", deviceId: "d1")
        return (c, m)
    }

    func testTestCreditThenPro() async {
        let (c, m) = center()
        await c.refreshAndTick()
        XCTAssertTrue(c.canSpend)
        XCTAssertEqual(c.balanceUnits, 0)
        let added = await c.addTestVouchers()
        XCTAssertTrue(added)
        XCTAssertEqual(c.balanceUnits, 30)
        XCTAssertTrue(c.needsBiometric(choosing: .pro, delayStart: false))
        XCTAssertFalse(c.needsBiometric(choosing: .pro, delayStart: true))
        let chosen = await c.choosePlan(.pro, delayStart: false)
        XCTAssertTrue(chosen)
        XCTAssertEqual(c.planState.plan, .pro)
        XCTAssertEqual(c.balanceUnits, 29)
        XCTAssertEqual(m.redeems.count, 1)
        XCTAssertEqual(PlanDisplay.daysLeft(c.planState, now: clock), 3)
    }

    func testCapAndAutoPaySync() async {
        let (c, m) = center()
        await c.refreshAndTick()
        await c.setOverageCap(20)
        XCTAssertEqual(c.wallet?.settings.overageCapUnits, 20)
        await c.setAutoPay(false)
        XCTAssertEqual(c.wallet?.settings.autoPay, false)
        XCTAssertEqual(VoucherWalletSync.version(m.wallets["plucky-avocet"]), 2)
    }

    func testReadOnlyDevices() async {
        let (viewer, m) = center(admin: false)
        await viewer.refreshAndTick()
        XCTAssertFalse(viewer.canSpend)
        XCTAssertFalse(viewer.isAdmin)
        let chosen = await viewer.choosePlan(.pro, delayStart: false)
        XCTAssertFalse(chosen)
        XCTAssertTrue(m.redeems.isEmpty)
        let (locked, _) = center(key: false)
        await locked.refreshAndTick()
        XCTAssertFalse(locked.hasKey)
        XCTAssertNil(locked.wallet)
    }

    func testDisplayRules() {
        let cfg = PaymentsConfig.defaults
        XCTAssertEqual(PlanDisplay.capChoices(cfg).first, 0)
        XCTAssertEqual(PlanDisplay.capChoices(cfg).last, 100)
        XCTAssertEqual(PlanDisplay.capChoices(cfg).count, 21)
        XCTAssertEqual(PlanDisplay.capGb(10, cfg), 200)
        XCTAssertNil(PlanDisplay.daysLeft(.free, now: clock))
        XCTAssertTrue(PlanDisplay.dollars(30, cfg).contains("30"))
        XCTAssertFalse(PlanDisplay.dollars(30, cfg).contains("."))
    }
}
