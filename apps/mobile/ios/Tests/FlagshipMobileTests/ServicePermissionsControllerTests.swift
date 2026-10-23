import XCTest
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class ServicePermissionsControllerTests: XCTestCase {
    private func world() -> (MockScreensClient, ServicePermissionsController) {
        let mock = MockScreensClient()
        mock.permissions["alice--chess"] = ServicePermissions(grants: [
            ServicePermissionGrant(id: "k1", kind: "app-api-key", capability: "read", issuedAt: 1, expiresAt: nil, secretAccess: false, openWork: []),
            ServicePermissionGrant(id: "k2", kind: "mcp-key", capability: "ide", issuedAt: 1, expiresAt: nil, secretAccess: true, openWork: ["a download"]),
        ])
        return (mock, ServicePermissionsController(serviceId: "alice--chess", client: mock))
    }

    func testLoadsEveryGrantAndAnOlderBoxShowsNothing() async {
        let (_, c) = world()
        await c.load()
        XCTAssertEqual(c.permissions?.grants.map(\.id), ["k1", "k2"])
        let failing = MockScreensClient()
        failing.shouldFail = true
        let none = ServicePermissionsController(serviceId: "x", client: failing)
        await none.load()
        XCTAssertTrue(none.isHidden)
    }

    func testEndingOneGrantLeavesTheOther() async {
        let (mock, c) = world()
        await c.load()
        await c.revoke(grantId: "k2")
        XCTAssertEqual(mock.permissionRevokes.first?.grantId, "k2")
        XCTAssertEqual(c.permissions?.grants.map(\.id), ["k1"])
        XCTAssertEqual(c.notice, "Access ended.")
    }

    func testEndingAllClearsThePage() async {
        let (_, c) = world()
        await c.load()
        await c.revoke(grantId: nil)
        XCTAssertEqual(c.permissions?.grants.count, 0)
        XCTAssertEqual(c.notice, "2 accesses ended.")
    }

    func testWordsNameStuckWork() {
        XCTAssertTrue(PermissionWords.outcome(PermissionRevokeResult(revoked: 1, stuckWork: ["a build"])).contains("a build"))
    }
}
