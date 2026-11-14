import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// The server page's "Direct access" (docs/direct-access-and-domains.md §8).
@MainActor
final class DirectAccessViewModelTests: XCTestCase {
    private let domain = "home.bright-maple.flagship.services"
    private let admin = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x5a, count: 32))
    private var clock: Int64 = 1_790_000_000_000
    private var prompts: [String] = []

    private func box() -> MockScreensClient {
        let m = MockScreensClient()
        m.simulatedLatency = 0
        return m
    }

    private func vm(_ box: MockScreensClient, _ com: MockDirectNamesClient, canManage: Bool = true) -> DirectAccessViewModel {
        let signer: DirectAccessViewModel.Signer = { [unowned self] reason in
            self.prompts.append(reason)
            return self.admin
        }
        return DirectAccessViewModel(serverDomain: domain, username: "bright-maple", box: box, com: com, canManage: canManage,
                                     accessSigner: signer, nameSigner: signer, now: { [unowned self] in self.clock })
    }

    func test_turnOnSignsOneOrderAndSendsItToTheBoxAndCom() async throws {
        let b = box(), com = MockDirectNamesClient()
        let m = vm(b, com)
        await m.load()
        XCTAssertTrue(m.supported)
        XCTAssertFalse(m.isOn)
        m.startEditing()
        m.addressesText = "81.2.69.142, 2A02:8010:6400:1:0:0:0:10"
        m.prefixesText = "2a02:8010:6400::/48"
        await m.saveAccess()
        XCTAssertNil(m.error)
        XCTAssertTrue(m.isOn)
        XCTAssertFalse(m.editing)
        XCTAssertEqual(prompts, ["Turn on direct access"])
        let sent = try XCTUnwrap(b.directAccessOrders.first)
        XCTAssertEqual(sent.order.addresses, ["2a02:8010:6400:1::10", "81.2.69.142"])
        XCTAssertEqual(com.accessOrders, [sent])
        XCTAssertTrue(DirectAccess.verify(sent.order, signatureHex: sent.signatureHex, pub: admin.publicKey.rawRepresentation))
        XCTAssertEqual(m.notice, "Direct access is on.")
    }

    func test_privateAddressIsRefusedBeforeSigning() async {
        let b = box(), com = MockDirectNamesClient()
        let m = vm(b, com)
        await m.load()
        m.startEditing()
        m.addressesText = "192.168.1.20"
        await m.saveAccess()
        XCTAssertEqual(m.error, DirectAccessText.refusal("private-address"))
        XCTAssertTrue(prompts.isEmpty)
        XCTAssertTrue(b.directAccessOrders.isEmpty)
    }

    func test_comRefusalShowsTheAppsSentence() async {
        let b = box(), com = MockDirectNamesClient()
        com.postError = DirectAccessRefusal(status: 403, code: "not-admin", message: "raw")
        let m = vm(b, com)
        await m.load()
        m.startEditing()
        m.addressesText = "81.2.69.142"
        await m.saveAccess()
        XCTAssertEqual(m.error, "Only an admin device of this account can change direct access.")
    }

    func test_namesAreDerivedOnlyForThisAccountsApps() async {
        let m = vm(box(), MockDirectNamesClient())
        await m.load()
        let plants = m.rows.first { $0.serviceId == "bright-maple--plants" }
        XCTAssertEqual(plants?.fqdn, "plants--bright-maple.fshp.app")
        for row in m.rows where !row.serviceId.hasPrefix("bright-maple--") { XCTAssertNil(row.fqdn, row.serviceId) }
    }

    func test_nameOnPublishesThenProbeAndSettings() async throws {
        let b = box(), com = MockDirectNamesClient()
        let m = vm(b, com)
        await m.load()
        m.startEditing()
        m.addressesText = "81.2.69.142"
        await m.saveAccess()
        let row = try XCTUnwrap(m.rows.first { $0.serviceId == "bright-maple--plants" })
        await m.turnOnName(row)
        XCTAssertNil(m.error)
        let sent = try XCTUnwrap(com.nameOrders.last)
        XCTAssertEqual(sent.order.name, "plants--bright-maple.fshp.app")
        XCTAssertEqual(sent.order.caa, .pin)
        XCTAssertTrue(sent.order.addresses.isEmpty)
        let on = try XCTUnwrap(m.rows.first { $0.serviceId == "bright-maple--plants" })
        XCTAssertEqual(on.state.map(DirectAccessText.state), "Published")

        await m.probe(on)
        XCTAssertEqual(m.notice, "Reachable from outside.")
        XCTAssertEqual(com.probes, ["plants--bright-maple"])

        m.editName(on)
        m.nameDraft?.pinCaa = false
        m.nameDraft?.addressesText = "81.2.69.143"
        await m.saveNameDraft()
        XCTAssertNil(m.nameDraft)
        XCTAssertEqual(com.nameOrders.last?.order.caa, .off)
        XCTAssertEqual(com.nameOrders.last?.order.addresses, ["81.2.69.143"])

        await m.turnOffName(try XCTUnwrap(m.rows.first { $0.serviceId == "bright-maple--plants" }))
        XCTAssertEqual(com.nameOrders.last?.order.enabled, false)
    }

    func test_nonAdminDeviceSignsNothing() async {
        let b = box(), com = MockDirectNamesClient()
        let m = vm(b, com, canManage: false)
        await m.load()
        m.addressesText = "81.2.69.142"
        await m.saveAccess()
        await m.turnOff()
        XCTAssertTrue(prompts.isEmpty)
        XCTAssertTrue(b.directAccessOrders.isEmpty)
    }

    func test_reasonsAndStatesHaveSentences() {
        for code in ["off", "suspended", "account-gone", "server-gone", "order-unverified", "direct-access-off", "no-addresses", "caa-account-unknown"] {
            XCTAssertNotNil(DirectAccessText.reason(code), code)
        }
        XCTAssertEqual(DirectAccessText.refusal("probe-too-soon"), "This name was checked a moment ago. Try again in a minute.")
        XCTAssertEqual(DirectAccessText.refusal("nope", fallback: "box sentence"), "box sentence")
        let empty = DirectNameState(name: "a--bright-maple.fshp.app", serverDomain: domain, enabled: true, state: "empty", reason: "direct-access-off")
        XCTAssertEqual(DirectAccessText.state(empty), "Direct access is off on its server.")
        let ready = DirectNameState(name: "a--bright-maple.fshp.app", serverDomain: domain, enabled: true, state: "empty",
                                    reason: "no-addresses", certificate: DirectNameCertificate(notAfter: 1_900_000_000_000))
        XCTAssertEqual(DirectAccessText.state(ready), "Certificate ready. Waiting for the direct path.")
    }
}
