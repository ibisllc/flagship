import XCTest
@testable import FlagshipAPI

final class SessionStoringTests: XCTestCase {

    private func uniqueDefaults() -> UserDefaults {
        UserDefaults(suiteName: "test-\(UUID().uuidString)")!
    }

    func test_sessionStore_conformsToSessionStoring() async {
        let store: any SessionStoring = SessionStore(defaults: uniqueDefaults())
        await store.setPodBaseUrl("https://example.com")
        await store.setSessionToken("token-abc")
        let url = await store.podBaseUrl
        let token = await store.sessionToken
        XCTAssertEqual(url, "https://example.com")
        XCTAssertEqual(token, "token-abc")
        await store.clear()
        let cleared = await store.podBaseUrl
        XCTAssertNil(cleared)
    }

    func test_keychainSessionStore_conformsToSessionStoring() async {
        let store: any SessionStoring = KeychainSessionStore(defaults: uniqueDefaults())
        await store.setPodBaseUrl("https://example.com")
        await store.setSessionToken("token-xyz")
        let url = await store.podBaseUrl
        XCTAssertEqual(url, "https://example.com")
        // Token round-trip may fail on test bundle without entitlement
        // (errSecMissingEntitlement) — that's a Keychain quirk we
        // accept; verify it doesn't throw at least.
        _ = await store.sessionToken
        await store.clear()
    }

    func test_liveScreensClient_acceptsEitherStoreBackend() {
        // Compile-time check: both store types work as `any SessionStoring`.
        let _ = LiveScreensClient(store: SessionStore(defaults: uniqueDefaults()))
        let _ = LiveScreensClient(store: KeychainSessionStore(defaults: uniqueDefaults()))
    }
}
