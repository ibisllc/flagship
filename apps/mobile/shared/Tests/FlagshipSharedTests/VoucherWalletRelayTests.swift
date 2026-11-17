import XCTest
import FlagshipAPI
@testable import FlagshipCore

/// Spends through the private relay (docs/outbound-proxy.md "Failure handling"): the owner's own choice goes directly
/// when the relay fails, the trickle waits and backs off unless the plan is about to lapse, overage never goes
/// directly, and the Plan screen's privacy line follows.
@MainActor
final class VoucherWalletRelayTests: XCTestCase {
    let umk = [UInt8](repeating: 0x42, count: 32)
    let device: VoiciDeviceSigner = { _, _ in AccountDirectoryAuthorization(deviceId: "d1", signerPubHex: String(repeating: "a", count: 64), requestId: "r", issuedAt: 1, signatureHex: "s") }
    var clock: Int64 = 1_795_000_000_000
    let minute: Int64 = 60_000
    let day: Int64 = 86_400_000

    private func setUp(_ configure: (MockPaymentsComClient) -> Void = { _ in }) async -> (MockPaymentsComClient, VoucherWalletEngine) {
        let m = MockPaymentsComClient()
        m.now = { [unowned self] in self.clock }
        configure(m)
        let key = umk
        let e = VoucherWalletEngine(client: m, context: .init(username: "plucky-avocet", isAdmin: true, umk: { key }, device: device),
                                    defaults: UserDefaults(suiteName: UUID().uuidString)!)
        e.now = { [unowned self] in self.clock }
        e.random = { 0.5 }
        await e.refresh()
        await e.addTestVouchers(30)
        return (m, e)
    }

    func testSpendsGoThroughTheRelayAndTheLineNamesItsOperator() async {
        let (m, e) = await setUp()
        XCTAssertEqual(e.spendPrivacy, .thirdPartyRelay(operator: "Example Relay Co"))
        await e.choosePlan(.pro, delayStart: false)
        XCTAssertEqual(e.planState.plan, .pro)
        XCTAssertEqual(m.paths, [.relay(url: "https://relay.example.net/flagship")])
        XCTAssertEqual(e.spendPrivacy, .thirdPartyRelay(operator: "Example Relay Co"))
    }

    func testInterimRelayAndNoRelay() async {
        let (_, e) = await setUp { $0.ohttp.relays[0].interim = true }
        XCTAssertEqual(e.spendPrivacy, .interimRelay)
        let (m2, e2) = await setUp { $0.ohttp = .empty }
        XCTAssertEqual(e2.spendPrivacy, .noRelay)
        await e2.choosePlan(.pro, delayStart: false)
        XCTAssertEqual(m2.paths, [.direct(reason: "unconfigured")])
        XCTAssertEqual(e2.planState.plan, .pro)
        XCTAssertEqual(e2.spendPrivacy, .noRelay)
    }

    func testChoosingAPlanGoesDirectlyWhenTheRelayFails() async {
        let (m, e) = await setUp { $0.relayDown = true }
        await e.choosePlan(.pro, delayStart: false)
        XCTAssertEqual(e.planState.plan, .pro)
        XCTAssertEqual(m.paths, [.direct(reason: "relay-unreachable")])
        XCTAssertNil(e.lastError)
        XCTAssertEqual(e.spendPrivacy, .wentDirect)
        // The next relay success clears it.
        m.relayDown = false
        clock = e.nextSpendAt
        await e.refresh()
        await e.tick()
        XCTAssertEqual(m.paths.last, .relay(url: "https://relay.example.net/flagship"))
        XCTAssertEqual(e.spendPrivacy, .thirdPartyRelay(operator: "Example Relay Co"))
    }

    func testTheTrickleWaitsAndBacksOffThenGoesDirectBeforeTheGraceRunsOut() async {
        let (m, e) = await setUp()
        await e.choosePlan(.pro, delayStart: false)
        let paidUntil = e.planState.paidUntil
        m.relayDown = true
        clock = e.nextSpendAt
        await e.refresh()
        let balance = e.balance
        await e.tick()
        // Far from lapsing: skipped, not sent, no error.
        XCTAssertEqual(m.paths.count, 1)
        XCTAssertEqual(e.balance, balance)
        XCTAssertNil(e.lastError)
        XCTAssertEqual(e.relayFailures, 1)
        XCTAssertEqual(e.relayRetryAt, clock + 5 * minute)
        XCTAssertEqual(e.spendPrivacy, .relayWaiting)
        // Resting: not tried again, not counted again.
        clock += minute
        await e.tick()
        XCTAssertEqual(e.relayFailures, 1)
        // Retry time: tried, failed again, waits twice as long.
        clock += 4 * minute
        await e.tick()
        XCTAssertEqual(e.relayFailures, 2)
        XCTAssertEqual(e.relayRetryAt, clock + 10 * minute)
        XCTAssertEqual(e.planState.paidUntil, paidUntil)
        // Inside the grace, less than a day before the plan would lapse: it goes directly, marked.
        clock = paidUntil + 72 * 3_600_000 - day / 2
        await e.tick()
        XCTAssertEqual(m.paths.last, .direct(reason: "relay-unreachable"))
        XCTAssertGreaterThan(e.planState.paidUntil, paidUntil)
        XCTAssertEqual(e.spendPrivacy, .relayWaiting)
        // The relay is back: a success resets everything.
        m.relayDown = false
        clock = max(clock + 6 * 3_600_000, e.nextSpendAt)
        await e.refresh()
        e.relayRetryAt = 0
        await e.tick()
        if case .relay? = m.paths.last {} else { XCTFail("expected a relay spend, got \(String(describing: m.paths.last))") }
        XCTAssertEqual(e.relayFailures, 0)
        XCTAssertEqual(e.spendPrivacy, .thirdPartyRelay(operator: "Example Relay Co"))
    }

    func testOverageNeverGoesDirect() async {
        let (m, e) = await setUp()
        await e.choosePlan(.pro, delayStart: false)
        m.relayDown = true
        m.usedBytes["plucky-avocet"] = 245 * 1_073_741_824
        await e.refresh()
        let before = m.paths.count
        await e.tick()
        XCTAssertEqual(m.paths.count, before)
        XCTAssertGreaterThanOrEqual(e.relayFailures, 1)
        XCTAssertNil(e.lastError)
    }

    func testPaymentsInfoParsesTheRelayConfig() {
        let v = JSONValue.parse("""
        {"config":{},"keys":[],"ohttp":{"v":1,"keyConfigHex":"07002036dedf3ad3da392abb9d76a42b926584935422de695e9b941ea4fa5193c7cd37000400010001",
         "relays":[{"url":"https://ohttp.flagshipserver.com/r","operator":"Us","interim":true},
                   {"url":"https://relay.example.net/r","operator":" Example ","interim":false}]}}
        """)
        let info = PaymentsInfo.parse(v, controlApex: "flagshipserver.com")
        XCTAssertEqual(info.ohttp.relays, [OhttpRelayEntry(url: "https://relay.example.net/r", operator: "Example", interim: false)])
        XCTAssertEqual(PaymentsInfo.parse(JSONValue.parse("{}"), controlApex: "flagshipserver.com").ohttp, .empty)
    }
}
