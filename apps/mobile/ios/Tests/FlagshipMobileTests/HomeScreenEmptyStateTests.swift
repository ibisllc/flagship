import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

/// #51 — the Home dashboard NEVER shows a "couldn't load" / "not paired" card.
/// When there's no server the Home screen already shows a create-server invite,
/// and the server list conveys per-server state, so a load failure on the
/// account-wide recent-activity feed simply drops that section. The card is
/// gone entirely — `shouldShowLoadError` always returns false, regardless of
/// pod state (no server, pending-only, online + load failure).
@MainActor
final class HomeScreenEmptyStateTests: XCTestCase {

    private func pod(_ status: PodInfo.Status, _ fqdn: String) -> PodInfo {
        PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: fqdn, description: nil,
                fqdn: fqdn, status: status,
                pendingAuthCodeSerial: status == .pending ? "SER" : nil)
    }

    func test_noServers_neverShowsErrorCard() {
        XCTAssertFalse(HomeScreen.shouldShowLoadError(pods: []))
    }

    func test_onlyPendingServer_neverShowsErrorCard() {
        let pods = [pod(.pending, "home.harry.flagship.services")]
        XCTAssertFalse(HomeScreen.shouldShowLoadError(pods: pods))
    }

    func test_onlineServerLoadFailure_neverShowsErrorCard() {
        // The owner is firm: even a genuine load failure against an online
        // server must NOT surface a "couldn't load" card on Home.
        let pods = [pod(.online, "home.harry.flagship.services")]
        XCTAssertFalse(HomeScreen.shouldShowLoadError(pods: pods))
    }

    func test_offlineOnlyServer_neverShowsErrorCard() {
        let pods = [pod(.offline, "home.harry.flagship.services")]
        XCTAssertFalse(HomeScreen.shouldShowLoadError(pods: pods))
    }
}
