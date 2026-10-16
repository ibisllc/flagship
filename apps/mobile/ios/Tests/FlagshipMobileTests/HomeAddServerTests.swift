import XCTest
@testable import FlagshipUI

/// Home's "Add/Import a server" is the one way to bring a server into the
/// account (Create / Co-manage / Import), with or without servers, and only an
/// admin device of the account sees it (docs/service-access-gating.md
/// "Account members"). Mirrors the webapp's webappHomeAddServer.test.ts and
/// Android's HomeAddServerTest.
@MainActor
final class HomeAddServerTests: XCTestCase {

    func test_aDeviceHoldingTheAdminRootSeesIt() {
        XCTAssertTrue(HomeScreen.showsAddServer(holdsAdminRoot: true, isDemoAccount: false))
    }

    func test_anotherDeviceOfTheAccountDoesNot() {
        XCTAssertFalse(HomeScreen.showsAddServer(holdsAdminRoot: false, isDemoAccount: false))
    }

    func test_aDemoAccountsDeviceDoes() {
        // A demo identity holds no keys; the operator runs the account.
        XCTAssertTrue(HomeScreen.showsAddServer(holdsAdminRoot: false, isDemoAccount: true))
    }

    func test_emptyHomeOffersAnAdminTheSameButton() {
        let empty = HomeScreen.emptyState(canAddServers: true)
        XCTAssertEqual(empty.headline, "Your account is ready")
        XCTAssertTrue(empty.showsAddServer)
    }

    func test_emptyHomeTellsANonAdminWhyThereIsNoButton() {
        let empty = HomeScreen.emptyState(canAddServers: false)
        XCTAssertEqual(empty.headline, "No servers yet")
        XCTAssertEqual(empty.hint, "Only an admin device of this account can add servers.")
        XCTAssertFalse(empty.showsAddServer)
    }
}
