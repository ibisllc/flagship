import XCTest
@testable import FlagshipCore

/// The retail claim flow against the scripted box: every stop the screens show, the receipt pin,
/// the key registration and the internet check (docs/retail-box-setup.md §4, §7).
@MainActor
final class RetailClaimFlowTests: XCTestCase {
    final class World: @unchecked Sendable {
        var registered: [BoxClaim.ClaimKey] = []
        var pinned: [String: String] = [:]
        var claimed: [String] = []
        var comStk: String? = MockBoxClaimRadio.stkPubHex
        var tls: Bool? = true
    }

    private func recipe(_ domain: String = "home.alice.flagship.services", serial: String = "retail-serial-0001") -> String {
        #"{"blob":{"serverDomain":"\#(domain)","authCode":{"serial":"\#(serial)"}},"blobSignature":"00"}"#
    }

    private func make(_ scenario: MockBoxClaimRadio.Scenario, world: World = World()) -> (RetailClaimViewModel, MockBoxClaimRadio, World) {
        let radio = MockBoxClaimRadio(scenario: scenario, appearAfterMs: 150, pressAfterArmMs: 400)
        var deps = RetailClaimDeps(
            username: "alice",
            radio: radio,
            mailboxLink: { _ in fatalError("no mailbox in these tests") },
            mintRecipe: { [r = recipe()] in (r, "home.alice.flagship.services", "retail-serial-0001") },
            registerKey: { k in world.registered.append(k) },
            pinStk: { d, k in world.pinned[d] = k },
            registeredStk: { _ in world.comStk },
            tlsCheck: { _ in world.tls },
            onClaimed: { d, _ in world.claimed.append(d) },
            region: "DE",
            pauseMs: { scenario == .earlyPress ? 1_500 : 200 }
        )
        deps.baselineMs = 80
        deps.pollMs = 20
        deps.onlineTimeoutMs = 300
        return (RetailClaimViewModel(deps: deps), radio, world)
    }

    private func until(_ vm: RetailClaimViewModel, _ what: String, timeout: TimeInterval = 10, _ ok: (RetailClaimViewModel.Phase) -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if ok(vm.phase) { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("\(what): still \(vm.phase)")
    }

    func testCableClaimEndsWithThePadlock() async {
        let (vm, radio, world) = make(.normal)
        vm.startBluetooth()
        await until(vm, "network step") { $0 == .chooseNetwork }
        XCTAssertEqual(world.registered.first?.stkPubHex, MockBoxClaimRadio.stkPubHex)
        XCTAssertEqual(world.pinned["home.alice.flagship.services"], MockBoxClaimRadio.stkPubHex)
        XCTAssertEqual(world.claimed, ["home.alice.flagship.services"])
        vm.useCable()
        await until(vm, "done") { $0 == .done(serverDomain: "home.alice.flagship.services") }
        XCTAssertEqual(radio.sentNetwork, .some(nil))
    }

    func testWifiWarnsThenRetriesAfterAWrongPassword() async {
        let (vm, radio, _) = make(.wrongPassword)
        vm.startBluetooth()
        await until(vm, "network step") { $0 == .chooseNetwork }
        vm.useWifi()
        await until(vm, "list") { if case .wifiList(let n) = $0 { return n.first?.ssid == "Home Wi-Fi" } else { return false } }
        vm.pickNetwork("Home Wi-Fi")
        XCTAssertFalse(vm.submitPassword(ssid: "Home Wi-Fi", password: "short"))
        XCTAssertTrue(vm.submitPassword(ssid: "Home Wi-Fi", password: "correct horse"))
        XCTAssertEqual(vm.phase, .wifiWarning(ssid: "Home Wi-Fi"))
        XCTAssertNil(radio.sentNetwork, "Nothing leaves before the warning.")
        vm.sendWifi()
        await until(vm, "wrong password") { $0 == .networkFailed(.wrongPassword) }
        vm.retryNetwork()
        vm.useWifi()
        await until(vm, "list again") { if case .wifiList = $0 { return true } else { return false } }
        _ = vm.submitPassword(ssid: "Home Wi-Fi", password: "correct horse")
        vm.sendWifi()
        await until(vm, "done") { $0 == .done(serverDomain: "home.alice.flagship.services") }
        XCTAssertEqual(radio.sentNetwork??.regulatoryRegion, "DE")
    }

    func testStops() async {
        let cases: [(MockBoxClaimRadio.Scenario, RetailClaimStop)] = [
            (.boxAlreadyNearby, .anotherBoxNearby),
            (.secondBox, .twoBoxes),
            (.earlyPress, .early),
            (.contention, .contention),
            (.doublePress, .burst),
            (.relayReceipt, .badReceipt),
        ]
        for (scenario, stop) in cases {
            let (vm, _, world) = make(scenario)
            vm.startBluetooth()
            await until(vm, scenario.rawValue) { $0 == .stopped(stop) }
            if scenario == .relayReceipt { XCTAssertTrue(world.registered.isEmpty, "A bad receipt registers nothing.") }
        }
    }

    func testAlarmWhenComHoldsAnotherKey() async {
        let w = World()
        w.comStk = String(repeating: "ee", count: 32)
        let (vm, _, _) = make(.normal, world: w)
        vm.startBluetooth()
        await until(vm, "network step") { $0 == .chooseNetwork }
        vm.useCable()
        await until(vm, "alarm") { $0 == .alarm(.keyMismatch, serverDomain: "home.alice.flagship.services") }
    }

    func testAlarmWhenTheBoxNeverRegisters() async {
        let w = World()
        w.comStk = nil
        let (vm, _, _) = make(.normal, world: w)
        vm.startBluetooth()
        await until(vm, "network step") { $0 == .chooseNetwork }
        vm.useCable()
        await until(vm, "alarm") { $0 == .alarm(.neverOnline, serverDomain: "home.alice.flagship.services") }
    }

    func testAlarmWhenTheCertificateDoesNotMatch() async {
        let w = World()
        w.tls = false
        let (vm, _, _) = make(.normal, world: w)
        vm.startBluetooth()
        await until(vm, "network step") { $0 == .chooseNetwork }
        vm.useCable()
        await until(vm, "alarm") { $0 == .alarm(.keyMismatch, serverDomain: "home.alice.flagship.services") }
    }

    func testPresenceRule() {
        let a = BoxClaimAdvert(peripheral: "p1", advertId: "aa", state: .unclaimed)
        let b = BoxClaimAdvert(peripheral: "p2", advertId: "bb", state: .unclaimed)
        var p = BoxClaimPresence()
        XCTAssertEqual(p.baseline([]), .waiting)
        p.endBaseline()
        XCTAssertEqual(p.observe([]), .waiting)
        XCTAssertEqual(p.observe([a]), .one(a))
        XCTAssertEqual(p.observe([]), .one(a), "A box dropping out of one scan is fine.")
        XCTAssertEqual(p.observe([b]), .twoBoxes, "Another id in its place stops the setup.")
        XCTAssertEqual(p.observe([a]), .twoBoxes, "Once stopped, it stays stopped.")
        var q = BoxClaimPresence()
        XCTAssertEqual(q.baseline([a]), .anotherBoxNearby)
    }

    func testBadSetupLinkStops() {
        let (vm, _, _) = make(.normal)
        vm.startWithCode("https://flagshipserver.com/claim#c=NOPE&v=1")
        XCTAssertEqual(vm.phase, .stopped(.badLink))
    }
}
