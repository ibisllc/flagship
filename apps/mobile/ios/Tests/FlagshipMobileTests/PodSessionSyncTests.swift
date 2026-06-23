import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// #51 — `podBaseUrl` must be derived from the selected ONLINE server's fqdn so
/// the LiveScreensClient can reach its daemon BFF. A `/pods`-reconciled server
/// never ran the pairing flow, so historically its base URL was never set and
/// every load threw `.notPaired`. PodSessionSync closes that gap and clears the
/// URL on sign-out / switch-away / pending-only.
@MainActor
final class PodSessionSyncTests: XCTestCase {

    private func store() -> any SessionStoring {
        SessionStore(defaults: UserDefaults(suiteName: "podsync-\(UUID().uuidString)")!)
    }

    private func onlinePod(_ fqdn: String) -> PodInfo {
        PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: "Home", fqdn: fqdn, status: .online)
    }

    func test_onlinePod_setsPodBaseUrlFromFqdn() async {
        let s = store()
        let pod = onlinePod("home.harry.flagship.services")
        await PodSessionSync.sync(currentPod: pod, store: s)
        let url = await s.podBaseUrl
        XCTAssertEqual(url, "https://home.harry.flagship.services")
    }

    func test_currentOnlinePodFromAppState_setsPodBaseUrl() async {
        let s = store()
        let app = AppState(
            isPaired: true, currentUser: "harry",
            pods: [onlinePod("home.harry.flagship.services")],
            leaderPodId: PodInfo.podId(forFqdn: "home.harry.flagship.services"),
            currentPodId: PodInfo.podId(forFqdn: "home.harry.flagship.services")
        )
        await PodSessionSync.sync(currentPod: app.currentPod, store: s)
        let url = await s.podBaseUrl
        XCTAssertEqual(url, "https://home.harry.flagship.services")
    }

    /// Regression for the leticia burn-test bug: a dead/oldest pod was the leader,
    /// so `currentPod` (= leader) nulled the box base URL and bricked the box
    /// surface for the one healthy pod. Driving the sync from `sessionPod`
    /// anchors on the live pod instead.
    func test_sessionPodFromAppState_skipsDeadLeaderForLivePod() async {
        let s = store()
        let app = AppState(
            isPaired: true, currentUser: "harry",
            pods: [
                PodInfo(podId: "frank", name: "frank", fqdn: "frank.harry.flagship.services", status: .offline),
                onlinePod("leticia.harry.flagship.services")
            ],
            leaderPodId: "frank",   // the dead, oldest pod is the leader (the bug)
            currentPodId: "frank"
        )
        // OLD behavior: currentPod = dead leader ⇒ base URL nulled (the brick).
        await PodSessionSync.sync(currentPod: app.currentPod, store: s)
        let urlOld = await s.podBaseUrl
        XCTAssertNil(urlOld)
        // FIX: sessionPod anchors on the live pod.
        await PodSessionSync.sync(currentPod: app.sessionPod, store: s)
        let urlNew = await s.podBaseUrl
        XCTAssertEqual(urlNew, "https://leticia.harry.flagship.services")
    }

    func test_pendingPod_clearsPodBaseUrl() async {
        let s = store()
        await s.setPodBaseUrl("https://stale.harry.flagship.services")
        let pending = PodInfo(podId: "p", name: "P", fqdn: "p.harry.flagship.services",
                              status: .pending, pendingAuthCodeSerial: "SER")
        await PodSessionSync.sync(currentPod: pending, store: s)
        let url = await s.podBaseUrl
        XCTAssertNil(url, "A pending server has no reachable daemon — clear the base URL.")
    }

    func test_nilPod_signOut_clearsPodBaseUrl() async {
        let s = store()
        await s.setPodBaseUrl("https://home.harry.flagship.services")
        await PodSessionSync.sync(currentPod: nil, store: s)
        let url = await s.podBaseUrl
        XCTAssertNil(url, "Sign-out / unpaired clears the base URL.")
    }

    func test_switchServers_repointsPodBaseUrl() async {
        let s = store()
        await PodSessionSync.sync(currentPod: onlinePod("a.harry.flagship.services"), store: s)
        var url = await s.podBaseUrl
        XCTAssertEqual(url, "https://a.harry.flagship.services")
        // Switch the current pod to a different online server.
        await PodSessionSync.sync(currentPod: onlinePod("b.harry.flagship.services"), store: s)
        url = await s.podBaseUrl
        XCTAssertEqual(url, "https://b.harry.flagship.services",
                       "Switching servers must repoint, not stack, the base URL.")
    }

    func test_emptyFqdn_clearsPodBaseUrl() async {
        let s = store()
        await s.setPodBaseUrl("https://prev")
        // A pre-delivery online-but-no-fqdn pod (degenerate) must not produce
        // a bogus "https://" base URL.
        let pod = PodInfo(podId: "x", name: "X", fqdn: "", status: .online)
        await PodSessionSync.sync(currentPod: pod, store: s)
        let url = await s.podBaseUrl
        XCTAssertNil(url)
    }
}
