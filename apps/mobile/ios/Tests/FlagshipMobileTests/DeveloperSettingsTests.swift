import XCTest
@testable import FlagshipCore

@MainActor
final class DeveloperSettingsTests: XCTestCase {

    /// A clean, isolated UserDefaults each test so persistence on one
    /// case can't leak into the next. Using a per-test suite name
    /// rather than .standard keeps the test runner's defaults file
    /// untouched.
    private func freshDefaults(_ name: String = UUID().uuidString) -> UserDefaults {
        let d = UserDefaults(suiteName: name)!
        for k in d.dictionaryRepresentation().keys { d.removeObject(forKey: k) }
        return d
    }

    func test_firstLaunch_appliesBuildConfigDefault() {
        // No key set yet → DeveloperSettings should pick up the
        // build-config default (DEBUG=false, RELEASE=true).
        let s = DeveloperSettings(defaults: freshDefaults())
        XCTAssertEqual(s.useLiveClient, DeveloperSettings.releaseDefaultUseLive)
    }

    func test_persistedTrue_winsOverBuildDefault() {
        let d = freshDefaults()
        d.set(true, forKey: "flagship.dev.useLiveClient")
        let s = DeveloperSettings(defaults: d)
        XCTAssertTrue(s.useLiveClient)
    }

    func test_persistedFalse_winsOverBuildDefault() {
        // Critical: a tester who explicitly flipped to mock must
        // stay on mock across launches — even on Release, where the
        // build default is live.
        let d = freshDefaults()
        d.set(false, forKey: "flagship.dev.useLiveClient")
        let s = DeveloperSettings(defaults: d)
        XCTAssertFalse(s.useLiveClient)
    }

    func test_settingUseLive_persistsAcrossInstances() {
        let d = freshDefaults()
        let a = DeveloperSettings(defaults: d)
        a.useLiveClient = true
        let b = DeveloperSettings(defaults: d)
        XCTAssertTrue(b.useLiveClient)
    }

    func test_unlockedFlag_persists() {
        let d = freshDefaults()
        let a = DeveloperSettings(defaults: d)
        XCTAssertFalse(a.unlocked)
        a.unlocked = true
        let b = DeveloperSettings(defaults: d)
        XCTAssertTrue(b.unlocked)
    }

    func test_mockLatencyMs_hasReasonableDefault() {
        let s = DeveloperSettings(defaults: freshDefaults())
        XCTAssertEqual(s.mockLatencyMs, 180)
    }

    func test_releaseDefaultUseLive_matchesBuildConfig() {
        // Pin the contract: Debug → mock, Release → live. The runtime
        // value depends on which configuration the tests compiled
        // under; assert the right one without relying on the # ifdef
        // expanding identically here.
        #if DEBUG
        XCTAssertFalse(DeveloperSettings.releaseDefaultUseLive)
        #else
        XCTAssertTrue(DeveloperSettings.releaseDefaultUseLive)
        #endif
    }
}
