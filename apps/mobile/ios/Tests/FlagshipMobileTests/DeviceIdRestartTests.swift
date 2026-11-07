import XCTest
@testable import FlagshipCore

/// A cold start must sign as the device `.com` registered, never a new random one (2026-11-07).
@MainActor
final class DeviceIdRestartTests: XCTestCase {
    private let registered = "91523f" + String(repeating: "0", count: 26)

    private func app(_ store: Box) -> AppState {
        let s = AppState()
        s.loadDeviceId = { store.ids[$0] }
        s.saveDeviceId = { store.ids[$0] = $1 }
        return s
    }

    private final class Box { var ids: [String: String] = [:] }

    private func withId(_ p: Profile, _ id: String) -> Profile {
        Profile(cloudName: p.cloudName, cloudRootPubHex: p.cloudRootPubHex, accountId: p.accountId, deviceId: id,
                accountDisplayName: p.accountDisplayName, deviceDisplayName: p.deviceDisplayName,
                deviceCapability: p.deviceCapability, demoServer: p.demoServer, createdAt: p.createdAt)
    }

    func test_restartRestoresTheRegisteredDeviceId() {
        let store = Box()
        let first = app(store)
        first.completeOnboarding(username: "plucky-daisy", pods: [])
        first.addProfile(withId(first.activeProfile!, registered))
        XCTAssertEqual(store.ids["plucky-daisy"], registered)

        let afterRestart = app(store)
        afterRestart.restorePersistedSession(username: "plucky-daisy")
        XCTAssertEqual(afterRestart.activeProfile?.deviceId, registered)
    }

    func test_aNewAccountAddedBeforeActivationIsSaved() {
        let store = Box()
        let s = app(store)
        s.addProfile(Profile(cloudName: "plucky-daisy", accountId: "plucky-daisy", deviceId: registered), setActive: false)
        s.completeOnboarding(username: "plucky-daisy", pods: [])
        XCTAssertEqual(store.ids["plucky-daisy"], registered)
        let afterRestart = app(store)
        afterRestart.restorePersistedSession(username: "plucky-daisy")
        XCTAssertEqual(afterRestart.activeProfile?.deviceId, registered)
    }

    func test_anInventedIdIsNeverSaved() {
        let store = Box()
        app(store).restorePersistedSession(username: "plucky-daisy")
        XCTAssertNil(store.ids["plucky-daisy"])
    }

    func test_adoptingTheAcceptedIdSavesIt() {
        let store = Box()
        let s = app(store)
        s.restorePersistedSession(username: "plucky-daisy")
        s.adoptRegisteredDeviceId(registered)
        XCTAssertEqual(s.activeProfile?.deviceId, registered)
        XCTAssertEqual(store.ids["plucky-daisy"], registered)
    }

    func test_repairTriesBoundKeysFirstAndStopsWhenOffline() async {
        let random = "39b80d" + String(repeating: "0", count: 26)
        let other = "ab" + String(repeating: "0", count: 30)
        let order = DeviceIdRepair.candidates(current: random, boundPq: [registered], otherPq: [other], kept: [random, "junk"])
        XCTAssertEqual(order, [random, registered, other])
        var tried: [String] = []
        let found = await DeviceIdRepair.find(order) { id in
            tried.append(id)
            return id == self.registered ? .accepted : .refused
        }
        XCTAssertEqual(found, registered)
        XCTAssertEqual(tried, [random, registered])
        let offline = await DeviceIdRepair.find(order) { _ in .unreachable }
        XCTAssertNil(offline)
    }
}
