import XCTest
import FlagshipAPI
import FlagshipCore

final class DemoSessionPairerTests: XCTestCase {
    private let username = "demoalice"
    private let server = DemoServerBlock(
        fqdn: "home.demoalice.flagship.services",
        status: "up"
    )

    private func store() -> SessionStore {
        SessionStore(defaults: UserDefaults(suiteName: "demo-session-\(UUID().uuidString)")!)
    }

    func testEnsurePairedMintsAndPersistsDemoSession() async throws {
        let client = MockFlagshipServerClient()
        client.simulatedLatency = 0
        client.demoServers[username] = server
        let store = store()
        let token = String(repeating: "ab", count: 32)

        let result = try await DemoSessionPairer.ensurePaired(
            username: username,
            server: server,
            client: client,
            store: store,
            makeToken: { token }
        )

        let storedPodToken = await store.sessionToken(forPodId: PodInfo.podId(forFqdn: server.fqdn))
        let activeToken = await store.sessionToken
        let podBaseUrl = await store.podBaseUrl
        let demoSession = await store.demoSession

        XCTAssertEqual(result, token)
        XCTAssertEqual(storedPodToken, token)
        XCTAssertEqual(activeToken, token)
        XCTAssertEqual(podBaseUrl, "https://\(server.fqdn)")
        XCTAssertEqual(demoSession, DemoSessionRecord(username: username, server: server))
    }

    func testEnsurePairedReusesStoredToken() async throws {
        let client = MockFlagshipServerClient()
        client.shouldFail = true
        let store = store()
        let podId = PodInfo.podId(forFqdn: server.fqdn)
        await store.setSessionToken("existing", forPodId: podId)

        let result = try await DemoSessionPairer.ensurePaired(
            username: username,
            server: server,
            client: client,
            store: store
        )

        let activeToken = await store.sessionToken
        let demoUsername = await store.demoSession?.username

        XCTAssertEqual(result, "existing")
        XCTAssertEqual(activeToken, "existing")
        XCTAssertEqual(demoUsername, username)
    }

    func testSignOutHookCanClearPersistedDemoMarker() async {
        let store = store()
        await store.setDemoSession(DemoSessionRecord(username: username, server: server))
        let app = await MainActor.run { AppState() }
        let cleared = expectation(description: "demo marker cleared")
        await MainActor.run {
            app.onSignedOut = {
                Task {
                    await store.setDemoSession(nil)
                    cleared.fulfill()
                }
            }
            app.signOut()
        }
        await fulfillment(of: [cleared], timeout: 1)
        let demoSession = await store.demoSession
        XCTAssertNil(demoSession)
    }
}
