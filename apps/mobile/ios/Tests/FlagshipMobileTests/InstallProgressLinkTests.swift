import XCTest
@testable import FlagshipUI
@testable import FlagshipAPI
@testable import FlagshipCore

/// The install Live Activity (and a provision-status push) opens the install
/// it tracks, never a new create flow.
final class InstallProgressLinkTests: XCTestCase {

    private var host: String { Endpoints.controlHost }

    func test_url_namesTheInstall_andRoundTrips() {
        let pending = DeepLink.installProgressURL(key: "01CAFE", serverFqdn: nil)
        XCTAssertEqual(pending.absoluteString, "https://\(host)/app/install-progress?serial=01CAFE")
        XCTAssertEqual(DeepLink.parse(pending), .installProgress(key: "01CAFE", serverFqdn: nil))

        let live = DeepLink.installProgressURL(key: "01CAFE", serverFqdn: "Home.U.flagship.services")
        XCTAssertEqual(live.absoluteString,
                       "https://\(host)/app/install-progress?serial=01CAFE&server=home.u.flagship.services")
        XCTAssertEqual(DeepLink.parse(live), .installProgress(key: "01CAFE", serverFqdn: "home.u.flagship.services"))

        let odd = DeepLink.installProgressURL(key: "a&b=c d", serverFqdn: "")
        XCTAssertEqual(DeepLink.parse(odd), .installProgress(key: "a&b=c d", serverFqdn: nil))
    }

    /// The shape `PodStatusSnapshot.installProgressURL` (the widget's twin) emits.
    func test_widgetShape_parses() {
        XCTAssertEqual(DeepLink.parse(URL(string: "https://\(host)/app/install-progress?serial=01CAFE&server=shed.u.flagship.services")!),
                       .installProgress(key: "01CAFE", serverFqdn: "shed.u.flagship.services"))
        XCTAssertEqual(DeepLink.parse(URL(string: "flagship://install-progress?serial=&server=")!),
                       .installProgress(key: nil, serverFqdn: nil))
    }

    func test_installLink_opensHome_notTheCreateFlow() {
        XCTAssertEqual(RootShell.tab(for: .installProgress(key: "01CAFE", serverFqdn: nil), selected: .apps), .home)
        XCTAssertNotEqual(DeepLink.parse(URL(string: "https://\(host)/app/install-progress")!), .createServer)
    }

    // MARK: Which page

    private let pending = PodInfo(podId: "pending-1", name: "Shed", fqdn: "shed.u.flagship.services",
                                  status: .pending, pendingAuthCodeSerial: "01CAFE")
    private let fqdnOnly = PodInfo(podId: "pending-2", name: "Barn", fqdn: "barn.u.flagship.services", status: .pending)
    private let online = PodInfo(podId: "home-1", name: "Home", fqdn: "home.u.flagship.services", status: .online)

    func test_route_bySerial_opensThePendingServer() {
        XCTAssertEqual(HomeTab.installRoute(key: "01CAFE", serverFqdn: nil, pods: [online, pending]),
                       .serverDetail(podId: "pending-1"))
    }

    func test_route_byAddressKey_whenThePhoneHeldNoSerial() {
        XCTAssertEqual(HomeTab.installRoute(key: "BARN.u.flagship.services", serverFqdn: nil, pods: [online, fqdnOnly]),
                       .serverDetail(podId: "pending-2"))
    }

    /// Once live the pod drops its serial; the activity's final state names the server.
    func test_route_afterGoingLive_opensTheServerPage() {
        let live = PodInfo(podId: "pending-1", name: "Shed", fqdn: "shed.u.flagship.services", status: .online)
        XCTAssertEqual(HomeTab.installRoute(key: "01CAFE", serverFqdn: "shed.u.flagship.services", pods: [online, live]),
                       .serverDetail(podId: "pending-1"))
    }

    func test_route_goneOrUnnamed_isNil() {
        XCTAssertNil(HomeTab.installRoute(key: "NOPE", serverFqdn: nil, pods: [online, pending]))
        XCTAssertNil(HomeTab.installRoute(key: nil, serverFqdn: nil, pods: [online, pending]))
        XCTAssertNil(HomeTab.installRoute(key: "", serverFqdn: "", pods: [PodInfo(podId: "x", name: "x", fqdn: "", status: .pending)]))
    }

    // MARK: Push

    func test_provisionStatusPush_opensItsInstall() {
        let push: [AnyHashable: Any] = [
            "category": "provision-status",
            "deepLink": "https://\(host)/app/install-progress",
            "meta": ["kind": "provision-status", "serial": "01CAFE", "phase": "installing"],
        ]
        XCTAssertEqual(PushNotifications.link(forPush: push), .installProgress(key: "01CAFE", serverFqdn: nil))
    }
}
