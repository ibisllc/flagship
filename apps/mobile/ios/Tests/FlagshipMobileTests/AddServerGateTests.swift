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
        let vm = CreateServerViewModel(username: "harry", server: server, relay: MockQrRelayClient(), isDemoAccount: false)
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
        let vm = CreateServerViewModel(username: "harry", server: server, relay: MockQrRelayClient(), isDemoAccount: false)
        vm.name = "home"
        _ = try await vm.mintRecipeJSON()

        let issued = try XCTUnwrap(server.issuedAuthCodes.values.first)
        XCTAssertEqual(issued.adminRootPubKey, pub, "the recipe pins the account's existing admin root")
        XCTAssertEqual(Keystore.adminRootPubHex(), pub, "minting never replaces the admin root")

        // `.com` refuses the code without the admin root's approval of it.
        let approval = try XCTUnwrap(server.issuedAdminSignatures[issued.serial], "the issue carries the admin approval")
        let root = try Curve25519.Signing.PublicKey(rawRepresentation: try XCTUnwrap(HexUtil.decode(pub)))
        let code = try Self.authCode(issued)
        XCTAssertTrue(root.isValidSignature(try XCTUnwrap(HexUtil.decode(approval)), for: try code.adminCanonicalBytes()))
    }

    // MARK: - what `.com` sees

    /// A demo account pins no root, so its issue carries no admin approval
    /// (`.com` keeps the demo account's IRK-only path).
    func test_aDemoAccountIssuesWithoutAnAdminApproval() async throws {
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "demo")
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = CreateServerViewModel(
            username: "harry", server: server, relay: MockQrRelayClient(),
            adminRootSigner: { _ in XCTFail("a demo account never unseals an admin root"); throw AddServerRefused() },
            isDemoAccount: true
        )
        vm.name = "home"
        _ = try await vm.mintRecipeJSON()
        let issued = try XCTUnwrap(server.issuedAuthCodes.values.first)
        XCTAssertNil(issued.adminRootPubKey)
        XCTAssertNil(server.issuedAdminSignatures[issued.serial])
    }

    /// `.com`'s 403 for a non-admin device reads as the apps' own sentence.
    func test_theServersRefusalShowsTheSameSentence() {
        let body = #"{"error":"Only an admin device of this account can add servers.","code":"add-server-admin-only"}"#
        XCTAssertEqual(ScreensClientError.http(status: 403, message: body).localizedDescription, AddServerGate.adminOnlyMessage)
    }

    private static func authCode(_ w: AuthCodeWire) throws -> AuthCode {
        AuthCode(
            version: w.version, serial: w.serial, username: w.username, serverName: w.serverName,
            serverDomain: w.serverDomain,
            delegatedPubKey: try XCTUnwrap(HexUtil.decode(w.delegatedPubKey)),
            userPubKey: try XCTUnwrap(HexUtil.decode(w.userPubKey)),
            issuedAt: w.issuedAt, expiresAt: w.expiresAt,
            adminRootPubKey: try w.adminRootPubKey.map { try XCTUnwrap(HexUtil.decode($0)) }
        )
    }
}
