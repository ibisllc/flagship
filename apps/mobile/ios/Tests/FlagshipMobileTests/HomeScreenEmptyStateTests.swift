import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

/// Home empty-state vs. ErrorCard gating (#50). The "couldn't load" card must
/// appear ONLY on a genuine data-load failure against an actual ONLINE server
/// — never for a user who simply hasn't created a server yet (welcome empty
/// state) or whose only server is still installing (pending).
@MainActor
final class HomeScreenEmptyStateTests: XCTestCase {

    private func pod(_ status: PodInfo.Status, _ fqdn: String) -> PodInfo {
        PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: fqdn, description: nil,
                fqdn: fqdn, status: status,
                pendingAuthCodeSerial: status == .pending ? "SER" : nil)
    }

    func test_noServers_suppressesErrorCard() {
        XCTAssertFalse(HomeScreen.shouldShowLoadError(pods: []))
    }

    func test_onlyPendingServer_suppressesErrorCard() {
        let pods = [pod(.pending, "home.harry.flagship.services")]
        XCTAssertFalse(HomeScreen.shouldShowLoadError(pods: pods))
    }

    func test_onlineServer_showsErrorCardOnFailure() {
        let pods = [pod(.online, "home.harry.flagship.services")]
        XCTAssertTrue(HomeScreen.shouldShowLoadError(pods: pods))
    }

    func test_offlineOnlyServer_suppressesErrorCard() {
        // Offline ≠ online; there's still nothing we successfully loaded, so a
        // "couldn't load" card would be misleading.
        let pods = [pod(.offline, "home.harry.flagship.services")]
        XCTAssertFalse(HomeScreen.shouldShowLoadError(pods: pods))
    }
}
