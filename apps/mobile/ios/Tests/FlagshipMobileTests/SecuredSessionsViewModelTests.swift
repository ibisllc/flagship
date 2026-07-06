import XCTest
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class SecuredSessionsViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"

    private func session(_ secret: String, started: Int64 = 1_700_000_000_000) -> SecuredSession {
        SecuredSession(
            secretId: secret,
            serverId: server,
            serviceRef: "alice--notes",
            serviceUrl: "https://notes.\(server)",
            browserAgent: "Mozilla/5.0",
            startedAt: started)
    }

    func testLoadReadsStoreMostRecentFirst() {
        let store = InMemorySecuredSessionStore()
        store.put(session("aa", started: 1_000))
        store.put(session("bb", started: 2_000))
        let vm = SecuredSessionsViewModel(client: MockServiceAccessClient(), store: store)
        vm.load()
        XCTAssertEqual(vm.sessions.map { $0.secretId }, ["bb", "aa"])
    }

    func testRefreshOnline() async {
        let store = InMemorySecuredSessionStore()
        let s = session("aa")
        store.put(s)
        let mock = MockServiceAccessClient()
        mock.sessionStatusResult = .online
        let vm = SecuredSessionsViewModel(client: mock, store: store)
        vm.load()
        await vm.refresh(s)
        XCTAssertEqual(vm.statuses["aa"], .online)
        XCTAssertEqual(mock.sessionStatusCalls.count, 1)
        XCTAssertEqual(mock.sessionStatusCalls[0].secretId, "aa")
    }

    func testRefreshOffline() async {
        let store = InMemorySecuredSessionStore()
        let s = session("aa")
        store.put(s)
        let mock = MockServiceAccessClient()
        mock.sessionStatusResult = .offline
        let vm = SecuredSessionsViewModel(client: mock, store: store)
        vm.load()
        await vm.refresh(s)
        XCTAssertEqual(vm.statuses["aa"], .offline)
    }

    func testRefreshDebouncedWithinWindow() async {
        let store = InMemorySecuredSessionStore()
        let s = session("aa")
        store.put(s)
        let mock = MockServiceAccessClient()
        mock.sessionStatusResult = .online
        var clock: Int64 = 1_700_000_000_000
        let vm = SecuredSessionsViewModel(client: mock, store: store, minRefreshMs: 60_000, now: { clock })
        vm.load()
        await vm.refresh(s)                    // first hits the box
        XCTAssertEqual(mock.sessionStatusCalls.count, 1)
        XCTAssertFalse(vm.canRefresh(s))       // too soon now
        clock += 30_000                        // still inside the 60s window
        await vm.refresh(s)                    // debounced — no second call
        XCTAssertEqual(mock.sessionStatusCalls.count, 1)
        XCTAssertTrue(vm.recentlyChecked.contains("aa"))
        clock += 31_000                        // past the window
        XCTAssertTrue(vm.canRefresh(s))
        await vm.refresh(s)                    // now hits the box again
        XCTAssertEqual(mock.sessionStatusCalls.count, 2)
        XCTAssertFalse(vm.recentlyChecked.contains("aa"))  // cleared on real refresh
    }

    func testServer429KeepsLastStatusAndFlagsRecentlyChecked() async {
        let store = InMemorySecuredSessionStore()
        let s = session("aa")
        store.put(s)
        let mock = MockServiceAccessClient()
        mock.sessionStatusResult = .online
        var clock: Int64 = 1_700_000_000_000
        let vm = SecuredSessionsViewModel(client: mock, store: store, minRefreshMs: 0, now: { clock })
        vm.load()
        await vm.refresh(s)
        XCTAssertEqual(vm.statuses["aa"], .online)
        // Next call: the box says 429 (clocks disagree). Keep online + hint.
        mock.nextError = ServiceAccessError.statusRateLimited
        clock += 1
        await vm.refresh(s)
        XCTAssertEqual(vm.statuses["aa"], .online)       // unchanged
        XCTAssertTrue(vm.recentlyChecked.contains("aa"))
    }

    func testStopClosesAndRemoves() async {
        let store = InMemorySecuredSessionStore()
        let s = session("aa")
        store.put(s)
        store.put(session("bb"))
        let mock = MockServiceAccessClient()
        let vm = SecuredSessionsViewModel(client: mock, store: store)
        vm.load()
        await vm.stop(s)
        XCTAssertEqual(mock.closeSessionCalls.count, 1)
        XCTAssertEqual(mock.closeSessionCalls[0].secretId, "aa")
        XCTAssertEqual(vm.sessions.map { $0.secretId }, ["bb"])
        XCTAssertEqual(store.list().map { $0.secretId }, ["bb"])
    }

    func testStopRemovesLocallyEvenIfCloseFails() async {
        let store = InMemorySecuredSessionStore()
        let s = session("aa")
        store.put(s)
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.knockBadRequest  // close throws
        let vm = SecuredSessionsViewModel(client: mock, store: store)
        vm.load()
        await vm.stop(s)
        XCTAssertTrue(vm.sessions.isEmpty)
        XCTAssertTrue(store.list().isEmpty)
    }
}
