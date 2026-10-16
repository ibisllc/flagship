import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship

/// Adding a server to the account (create, co-manage, take over, import a
/// backup) is for the account's admin devices only, and recipe minting never
/// mints an admin root: only opening the account does. Mirrors the webapp's
/// webappAddServerGate.test.ts and Android's AddServerGateTest.
@MainActor
final class AddServerGateTests: XCTestCase {

    override func tearDown() async throws {
        Keystore.wipe()
        try? Keystore.setPendingIrkRotationVersion(nil)
        try await super.tearDown()
    }

    // MARK: - the rule

    func test_onlyAnAdminDeviceOrADemoAccountMayAddServers() {
        XCTAssertTrue(AddServerGate.allows(holdsAdminRoot: true, isDemoAccount: false))
        XCTAssertFalse(AddServerGate.allows(holdsAdminRoot: false, isDemoAccount: false))
        XCTAssertTrue(AddServerGate.allows(holdsAdminRoot: false, isDemoAccount: true))
        XCTAssertEqual(AddServerGate.adminOnlyMessage, "Only an admin device of this account can add servers.")
    }

    func test_everyFlowThatAddsAServerIsGated() {
        XCTAssertTrue(HomeRoute.provisionServer.addsServerToAccount)
        XCTAssertTrue(HomeRoute.provisionServerForBuilder(link: "https://flagshipserver.com/builder?c=1").addsServerToAccount)
        XCTAssertTrue(HomeRoute.transferAcquirer(offerText: "{}").addsServerToAccount)
        XCTAssertTrue(HomeRoute.acceptShare(shareId: nil, secretHex: nil).addsServerToAccount)
        XCTAssertTrue(HomeRoute.acceptShare(shareId: "s", secretHex: "k").addsServerToAccount)
        XCTAssertTrue(HomeRoute.importBackup(targetFqdn: nil).addsServerToAccount)
        XCTAssertTrue(HomeRoute.importBackup(targetFqdn: "home.harry.flagship.services").addsServerToAccount)
    }

    func test_everythingElseOnHomeIsNot() {
        XCTAssertFalse(HomeRoute.serverDetail(podId: "p").addsServerToAccount)
        XCTAssertFalse(HomeRoute.installProgress(serial: "s", name: "n", description: "").addsServerToAccount)
        XCTAssertFalse(HomeRoute.sharedServer(shareId: "s").addsServerToAccount)
        XCTAssertFalse(HomeRoute.sharedApp(shareId: "s", serviceId: "a").addsServerToAccount)
    }

    func test_recipePinsTheDevicesAdminRoot_refusesWithout_demoPinsNone() throws {
        XCTAssertEqual(try AddServerGate.recipeAdminRootPin(adminRootPubHex: "ab", isDemoAccount: false), "ab")
        XCTAssertNil(try AddServerGate.recipeAdminRootPin(adminRootPubHex: nil, isDemoAccount: true))
        XCTAssertThrowsError(try AddServerGate.recipeAdminRootPin(adminRootPubHex: nil, isDemoAccount: false)) { error in
            XCTAssertEqual(error as? AddServerRefused, AddServerRefused())
            XCTAssertEqual(error.localizedDescription, AddServerGate.adminOnlyMessage)
        }
    }

    // MARK: - minting

    /// The stray-mint case: a device of an existing account (UMK, no admin
    /// root) used to be able to reach the mint. It must be refused before any
    /// `.com` call, and it must NOT come out holding a fresh admin root.
    func test_aNonAdminDeviceIsRefused_andNoAdminRootIsMinted() async throws {
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "paired device")
        XCTAssertFalse(Keystore.hasAdminRoot, "precondition: a non-admin device")

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = CreateServerViewModel(username: "harry", server: server, relay: MockQrRelayClient())
        vm.name = "home"
        do {
            _ = try await vm.mintRecipeJSON()
            XCTFail("a non-admin device must not mint a recipe")
        } catch {
            XCTAssertEqual(error as? AddServerRefused, AddServerRefused())
            XCTAssertEqual(error.localizedDescription, "Only an admin device of this account can add servers.")
        }
        XCTAssertFalse(Keystore.hasAdminRoot, "minting must never create an admin root")
        XCTAssertNil(Keystore.adminRootPubHex())
        XCTAssertTrue(server.issuedAuthCodes.isEmpty, "refused before any auth-code")
        XCTAssertTrue(server.registeredRcks.isEmpty, "refused before any RCK")
    }

    func test_anAdminDevicePinsTheRootItAlreadyHolds() async throws {
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "open account")
        let pub = try await Keystore.generateAdminRoot(reason: "open account")

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = CreateServerViewModel(username: "harry", server: server, relay: MockQrRelayClient())
        vm.name = "home"
        _ = try await vm.mintRecipeJSON()

        let issued = try XCTUnwrap(server.issuedAuthCodes.values.first)
        XCTAssertEqual(issued.adminRootPubKey, pub, "the recipe pins the account's existing admin root")
        XCTAssertEqual(Keystore.adminRootPubHex(), pub, "minting never replaces the admin root")
    }
}
