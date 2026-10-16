import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipUI
import FlagshipCore

/// Admin-only orders (removing an app, "Runs on", access-list answers, API
/// keys, data writes) are offered only to an admin device or a demo account;
/// any other device sees them read-only with the reason, and never signs an
/// order an admin-pinned box would refuse.
@MainActor
final class AdminOrderGateTests: XCTestCase {

    private let plants = "bright-maple--plants"
    private let home = "home.bright-maple.flagship.services"

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.podContext = "home"
        return c
    }

    func test_rule_adminRootOrDemoAccount() {
        XCTAssertTrue(AddServerGate.allows(holdsAdminRoot: true, isDemoAccount: false))
        XCTAssertTrue(AddServerGate.allows(holdsAdminRoot: false, isDemoAccount: true))
        XCTAssertFalse(AddServerGate.allows(holdsAdminRoot: false, isDemoAccount: false))
    }

    func test_nonAdminDevice_seesTheServicePageReadOnly_withReasons() async {
        let client = makeClient()
        let pods = [PodInfo(podId: PodInfo.podId(forFqdn: home), name: "Home", fqdn: home, status: .online)]
        let vm = ServiceDetailViewModel(serviceId: plants, client: client, allPods: pods,
                                        clients: .shared(client), serverDomain: home,
                                        egressSigner: { _ in Curve25519.Signing.PrivateKey() },
                                        adminOrders: false, canUninstall: false)
        await vm.load()
        XCTAssertFalse(vm.ordersCanChange)
        XCTAssertEqual(vm.access?.canChange, false)
        XCTAssertEqual(vm.access?.readOnlyNote, AdminOrderGate.accessList)
        XCTAssertEqual(vm.apiKeys?.canChange, false)
        XCTAssertEqual(vm.apiKeys?.readOnlyNote, AdminOrderGate.apiKeys)
        XCTAssertEqual(vm.runsOn?.canChange, false)
        XCTAssertEqual(vm.runsOn?.readOnlyNote, AdminOrderGate.runsOn)
        XCTAssertTrue(vm.showsDatabase, "a non-admin owner device still browses the data")

        let answered = await vm.access?.answer(host: vm.access?.pending.first?.host ?? "", action: .allow)
        XCTAssertNotEqual(answered, true)
        let created = await vm.apiKeys?.create(label: "x", scope: .read)
        XCTAssertNotEqual(created, true)
        XCTAssertTrue(client.serviceCopyCalls.isEmpty)
    }

    func test_adminDevice_mayChangeEverything() async {
        let client = makeClient()
        let vm = ServiceDetailViewModel(serviceId: plants, client: client, allPods: [], serverDomain: home,
                                        egressSigner: { _ in Curve25519.Signing.PrivateKey() })
        await vm.load()
        XCTAssertTrue(vm.ordersCanChange)
        XCTAssertEqual(vm.access?.canChange, true)
        XCTAssertNil(vm.access?.readOnlyNote)
        XCTAssertEqual(vm.apiKeys?.canChange, true)
    }

    func test_restrictedProfile_keepsItsOwnSentences() async {
        let vm = ServiceDetailViewModel(serviceId: plants, client: makeClient(), allPods: [], serverDomain: home,
                                        accessCanChange: false, adminOrders: true, canUninstall: false)
        await vm.load()
        XCTAssertEqual(vm.apiKeys?.readOnlyNote, AppApiKeysCopy.readOnlyNote)
        XCTAssertNil(vm.access?.readOnlyNote)
    }

    func test_dataWrite_onANonAdminDevice_isRefusedWithoutAskingFaceID() async {
        let client = makeClient()
        var prompts = 0
        let q = AppDbQueryController(serviceId: plants, store: "default", appName: "Plants", client: client,
                                     serverDomain: home, canWrite: false,
                                     signer: { _ in prompts += 1; return Curve25519.Signing.PrivateKey() })
        q.sql = "DELETE FROM waterings"
        await q.run()
        XCTAssertEqual(q.phase, .failed(AdminOrderGate.dataWrite))
        await q.confirmWrite()
        XCTAssertEqual(prompts, 0)
        XCTAssertTrue(client.serviceDbQueryCalls.allSatisfy { $0.req.grant == nil })

        q.sql = "SELECT * FROM waterings"
        await q.run()
        XCTAssertEqual(q.result?.command, "SELECT", "reads still run")
    }
}
