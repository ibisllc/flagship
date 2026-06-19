import XCTest
@testable import FlagshipCore

/// The local store of browser QR-login sessions THIS phone has authorized
/// (docs/service-access-gating.md, "Web-experience gating").
final class SecuredSessionStoreTests: XCTestCase {

    private func makeSession(_ secret: String, started: Int64) -> SecuredSession {
        SecuredSession(
            secretId: secret,
            serverId: "home.alice.flagship.services",
            serviceRef: "alice-notes",
            serviceUrl: "https://notes.home.alice.flagship.services",
            browserAgent: "Mozilla/5.0",
            startedAt: started)
    }

    func testInMemoryRoundtripSortedAndRemove() {
        let store = InMemorySecuredSessionStore()
        store.put(makeSession("aa", started: 1_000))
        store.put(makeSession("bb", started: 3_000))
        store.put(makeSession("cc", started: 2_000))
        XCTAssertEqual(store.list().map { $0.secretId }, ["bb", "cc", "aa"])
        store.remove(secretId: "bb")
        XCTAssertEqual(store.list().map { $0.secretId }, ["cc", "aa"])
    }

    func testPutReplacesBySecretId() {
        let store = InMemorySecuredSessionStore()
        store.put(makeSession("aa", started: 1_000))
        store.put(makeSession("aa", started: 9_000))
        XCTAssertEqual(store.list().count, 1)
        XCTAssertEqual(store.list()[0].startedAt, 9_000)
    }

    func testSecretIdLowercased() {
        let s = SecuredSession(
            secretId: "ABCDEF",
            serverId: "x", serviceRef: "y", serviceUrl: "z",
            browserAgent: "b", startedAt: 1)
        XCTAssertEqual(s.secretId, "abcdef")
        let store = InMemorySecuredSessionStore()
        store.put(s)
        // remove must match regardless of input case.
        store.remove(secretId: "ABCDEF")
        XCTAssertTrue(store.list().isEmpty)
    }

    func testUserDefaultsRoundtripPersists() {
        let suite = "flagship.test.securedSessions.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let key = "test.securedSessions"
        let a = UserDefaultsSecuredSessionStore(defaults: defaults, storageKey: key)
        a.put(makeSession("aa", started: 5_000))
        // A second instance reads back the same blob (UserDefaults persistence).
        let b = UserDefaultsSecuredSessionStore(defaults: defaults, storageKey: key)
        XCTAssertEqual(b.list().map { $0.secretId }, ["aa"])
        b.remove(secretId: "aa")
        XCTAssertTrue(UserDefaultsSecuredSessionStore(defaults: defaults, storageKey: key).list().isEmpty)
    }

    func testServiceUrlBuilder() {
        XCTAssertEqual(
            SecuredSession.serviceUrl(svc: "notes", serverDomain: "home.alice.flagship.services"),
            "https://notes.home.alice.flagship.services")
        XCTAssertEqual(
            SecuredSession.serviceUrl(svc: "", serverDomain: "home.alice.flagship.services"),
            "https://home.alice.flagship.services")
    }
}
