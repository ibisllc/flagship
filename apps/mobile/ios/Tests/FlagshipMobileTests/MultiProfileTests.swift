import XCTest
@testable import FlagshipCore

/// W3 — multi-profile (multi-cloud) AppState invariants. The Phase F
/// demo case is one profile per phone; the v2 capability lets a phone
/// hold several (personal + family + work). Switching profiles re-
/// mirrors the active profile's session state into the legacy single-
/// identity fields so existing callsites that read `currentUser` keep
/// working.
final class MultiProfileTests: XCTestCase {

    func test_completeOnboarding_addsProfileAndMarksActive() {
        let s = AppState()
        s.completeOnboarding(username: "harry", pods: [])
        XCTAssertEqual(s.profiles.count, 1)
        XCTAssertEqual(s.profiles.first?.cloudName, "harry")
        XCTAssertEqual(s.activeProfileCloudName, "harry")
        XCTAssertEqual(s.activeProfile?.cloudName, "harry")
    }

    func test_addProfile_thenSwitch_changesActiveProfileAndCurrentUser() {
        let s = AppState()
        s.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "a", name: "A", fqdn: "a.harry.flagship.services")
        ])
        s.addProfile(
            Profile(cloudName: "jay-family", deviceLabel: "phone"),
            setActive: false
        )
        XCTAssertEqual(s.profiles.count, 2)
        XCTAssertEqual(s.activeProfileCloudName, "harry")
        XCTAssertEqual(s.currentUser, "harry")
        XCTAssertEqual(s.pods.count, 1)

        s.setActiveProfile("jay-family")
        XCTAssertEqual(s.activeProfileCloudName, "jay-family")
        XCTAssertEqual(s.activeProfile?.cloudName, "jay-family")
        XCTAssertEqual(s.currentUser, "jay-family")
        // Pods are NOT carried across — the new cloud's pods come from
        // /devices on the next fetch.
        XCTAssertTrue(s.pods.isEmpty)
    }

    func test_setActiveProfile_ignoresUnknownCloudName() {
        let s = AppState()
        s.completeOnboarding(username: "harry", pods: [])
        s.setActiveProfile("does-not-exist")
        XCTAssertEqual(s.activeProfileCloudName, "harry")
        XCTAssertEqual(s.currentUser, "harry")
    }

    func test_profileCodableRoundTrip_preservesIdentityFields() throws {
        let p = Profile(
            cloudName: "harry",
            cloudRootPubHex: "deadbeef",
            deviceLabel: "iphone",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let data = try JSONEncoder().encode(p)
        let decoded = try JSONDecoder().decode(Profile.self, from: data)
        XCTAssertEqual(decoded.cloudName, "harry")
        XCTAssertEqual(decoded.cloudRootPubHex, "deadbeef")
        XCTAssertEqual(decoded.deviceLabel, "iphone")
        XCTAssertEqual(decoded.createdAt.timeIntervalSince1970, 1_700_000_000, accuracy: 0.001)
    }

    func test_completeOnboarding_replacesExistingProfileForSameCloud() {
        let s = AppState()
        s.completeOnboarding(username: "harry", pods: [])
        s.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "x", name: "X", fqdn: "x.harry.flagship.services")
        ])
        // Still ONE profile — re-onboarding the same cloud refreshes
        // rather than duplicates.
        XCTAssertEqual(s.profiles.count, 1)
        XCTAssertEqual(s.profiles.first?.cloudName, "harry")
    }

    func test_signOut_clearsActiveProfileButKeepsProfileList() {
        let s = AppState()
        s.completeOnboarding(username: "harry", pods: [])
        s.addProfile(Profile(cloudName: "jay-family"))
        XCTAssertEqual(s.profiles.count, 2)

        s.signOut()
        XCTAssertNil(s.activeProfileCloudName)
        XCTAssertNil(s.currentUser)
        // The durable profile list survives sign-out so the user can
        // pick a cloud back up after re-authenticating.
        XCTAssertEqual(s.profiles.count, 2)
    }
}
