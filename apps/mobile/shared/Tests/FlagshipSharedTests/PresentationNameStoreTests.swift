import XCTest
@testable import FlagshipCore

/// Home's header showed "Elated Iris > Pixel" until the app was reopened and
/// then only "elated-iris": the names were learned on Settings and kept in
/// memory. They are saved on the phone and read back when the account opens.
@MainActor
final class PresentationNameStoreTests: XCTestCase {
    private func store() -> PresentationNameStore {
        PresentationNameStore(defaults: UserDefaults(suiteName: "names-\(UUID().uuidString)")!)
    }

    func test_putThenGet() {
        let s = store()
        XCTAssertNil(s.get("elated-iris"))
        s.put("elated-iris", account: "Elated Iris", device: "Pixel")
        XCTAssertEqual(s.get("elated-iris"), .init(account: "Elated Iris", device: "Pixel"))
        XCTAssertEqual(s.get("ELATED-IRIS"), .init(account: "Elated Iris", device: "Pixel"), "keyed case-insensitively")
    }

    func test_aMissingNameNeverErasesOneAlreadySaved() {
        let s = store()
        s.put("a", account: "Elated Iris", device: "Pixel")
        s.put("a", account: nil, device: "Tablet")
        XCTAssertEqual(s.get("a"), .init(account: "Elated Iris", device: "Tablet"))
        s.put("a", account: "", device: nil)
        XCTAssertEqual(s.get("a"), .init(account: "Elated Iris", device: "Tablet"))
    }

    func test_clearForgetsTheAccount() {
        let s = store()
        s.put("a", account: "A", device: "D")
        s.clear("a")
        XCTAssertNil(s.get("a"))
    }

    func test_aRelaunchShowsTheNamesWithoutVisitingSettings() {
        let s = store()
        let first = AppState()
        first.presentationNames = s
        first.completeOnboarding(username: "elated-iris", pods: [])
        XCTAssertNil(first.activeProfile?.accountDisplayName, "nothing learned yet")
        // Settings loads the directory and caches what it decrypted.
        first.cachePresentationNames(accountDisplayName: "Elated Iris", deviceDisplayName: "Pixel")
        XCTAssertEqual(first.activeProfile?.accountDisplayName, "Elated Iris")

        // The app is reopened: a new AppState, the account restored from the keychain.
        let second = AppState()
        second.presentationNames = s
        second.restorePersistedSession(username: "elated-iris")
        XCTAssertEqual(second.activeProfile?.accountDisplayName, "Elated Iris")
        XCTAssertEqual(second.activeProfile?.deviceDisplayName, "Pixel")
    }

    func test_signingOutForgetsThem() {
        let s = store()
        let app = AppState()
        app.presentationNames = s
        app.completeOnboarding(username: "elated-iris", pods: [])
        app.cachePresentationNames(accountDisplayName: "Elated Iris", deviceDisplayName: "Pixel")
        app.signOut()
        XCTAssertNil(s.get("elated-iris"))
    }

    func test_withoutAStoreNothingIsKept() {
        let app = AppState()
        app.completeOnboarding(username: "a", pods: [])
        app.cachePresentationNames(accountDisplayName: "A", deviceDisplayName: nil)
        let other = AppState()
        other.restorePersistedSession(username: "a")
        XCTAssertNil(other.activeProfile?.accountDisplayName)
    }
}
