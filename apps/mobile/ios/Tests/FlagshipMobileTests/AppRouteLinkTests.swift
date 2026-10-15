import XCTest
@testable import FlagshipUI
@testable import FlagshipAPI
@testable import FlagshipCore

/// In-app destinations travel as `https://<controlHost>/app/<route>` and route
/// exactly like their legacy `flagship://<route>` twins, which still parse.
final class AppRouteLinkTests: XCTestCase {

    private var host: String { Endpoints.controlHost }

    private func parse(_ s: String) -> DeepLink? { DeepLink.parse(URL(string: s)!) }

    func test_appRoutes_matchTheirLegacyForms() {
        let pairs: [(String, DeepLink)] = [
            ("secret-requests", .secretRequests),
            ("unlock-approve?requestId=r1", .secretRequests),
            ("server?podId=home-abc123", .serverDetail(podId: "home-abc123")),
            ("app?serviceId=plants", .appDetail(serviceId: "plants")),
            ("create-server", .createServer),
            ("vibecode/sess-abc-42", .vibeCodeChat(sessionId: "sess-abc-42")),
            ("vibecode?sessionId=sess-xyz-99", .vibeCodeChat(sessionId: "sess-xyz-99")),
            ("account/security?u=bright-maple", .accountSecurity),
            ("account/devices?u=bright-maple", .accountDevices),
            ("account/re-pair?u=bright-maple", .accountDevices),
            ("account/activity", .accountActivity),
            ("settings/two-factor", .accountSecurity),
            ("install-progress", .createServer),
        ]
        for (route, expected) in pairs {
            XCTAssertEqual(parse("flagship://\(route)"), expected, "flagship://\(route)")
            XCTAssertEqual(parse("https://\(host)/app/\(route)"), expected, "/app/\(route)")
            XCTAssertEqual(parse("https://www.\(host)/app/\(route)"), expected, "www /app/\(route)")
        }
    }

    func test_appRoutes_keepPathAndPercentEncoding() {
        XCTAssertEqual(parse("https://\(host)/app/server?podId=a%20b"), .serverDetail(podId: "a b"))
        XCTAssertEqual(parse("https://\(host)/app/vibecode/sess-1/"), .vibeCodeChat(sessionId: "sess-1"))
    }

    func test_appRoutes_needTheControlHostAndARoute() {
        XCTAssertNil(parse("https://evil.example/app/server?podId=x"))
        XCTAssertNil(parse("http://\(host)/app/server?podId=x"))
        XCTAssertNil(parse("https://\(host)/app/"))
        XCTAssertNil(parse("https://\(host)/app"))
        XCTAssertNil(parse("https://\(host)/app/no-such-route"))
        XCTAssertNil(parse("https://\(host)/app/a:b"))
        XCTAssertNil(parse("https://\(host)/app/account/unknown"))
        XCTAssertNil(parse("https://\(host)/app/settings/other"))
        XCTAssertNil(parse("https://\(host)/server?podId=x"))
    }

    func test_appRouteURL_buildsTheHttpsForm() {
        XCTAssertEqual(DeepLink.appRouteURL("secret-requests").absoluteString, "https://\(host)/app/secret-requests")
        let server = DeepLink.appRouteURL("server", query: ["podId": "home.u.flagship.services"])
        XCTAssertEqual(server.absoluteString, "https://\(host)/app/server?podId=home.u.flagship.services")
        XCTAssertEqual(DeepLink.parse(server), .serverDetail(podId: "home.u.flagship.services"))
    }

    func test_appRouteURL_escapesQueryValues() {
        let url = DeepLink.appRouteURL("server", query: ["podId": "a&b=c d+e"])
        XCTAssertEqual(DeepLink.parse(url), .serverDetail(podId: "a&b=c d+e"))
    }

    func test_newDestinations_openTheSettingsTab() {
        XCTAssertEqual(RootShell.tab(for: .accountSecurity, selected: .home), .settings)
        XCTAssertEqual(RootShell.tab(for: .accountDevices, selected: .apps), .settings)
        XCTAssertEqual(RootShell.tab(for: .accountActivity, selected: .home), .activity)
    }

    // The Worker's invite-created notice as APNs delivers it.
    func test_push_inviteCreated_opensTheAccountActivity() {
        let aps: [AnyHashable: Any] = ["category": "invite-created",
                                       "alert": ["title": "Flagship", "body": "A device on your account invited someone to one of your apps."]]
        XCTAssertEqual(
            PushNotifications.link(forPush: ["aps": aps, "kind": "invite-created",
                                             "deepLink": "https://\(host)/app/account/activity"]),
            .accountActivity)
        XCTAssertEqual(PushNotifications.link(forPush: ["aps": aps]), .accountActivity, "no link: the category still routes")
        XCTAssertEqual(PushNotifications.link(forPush: ["category": "invite-created", "kind": "invite-created"]), .accountActivity)
        XCTAssertEqual(PushNotifications.link(forPush: ["flagship_url": "flagship://account/activity"]), .accountActivity)
    }

    // MARK: - Push payloads

    func test_push_deepLinkField_routes() {
        XCTAssertEqual(
            PushNotifications.link(forPush: ["deepLink": "https://\(host)/app/account/security?u=bright-maple"]),
            .accountSecurity)
        XCTAssertEqual(
            PushNotifications.link(forPush: ["deepLink": "https://\(host)/app/account/re-pair?u=bright-maple",
                                             "category": "re-pair-alert"]),
            .accountDevices)
        XCTAssertEqual(
            PushNotifications.link(forPush: ["deepLink": "https://\(host)/app/settings/two-factor"]),
            .accountSecurity)
    }

    func test_push_legacyUrlField_stillRoutes() {
        XCTAssertEqual(PushNotifications.link(forPush: ["flagship_url": "flagship://account/devices?u=x"]), .accountDevices)
    }

    func test_push_unreadableLink_fallsBackToKind() {
        XCTAssertEqual(
            PushNotifications.link(forPush: ["deepLink": "https://elsewhere.example/x", "category": "secret-request"]),
            .secretRequests)
    }

    // The Worker's boot-approval wake as APNs delivers it: the category only
    // inside `aps`, `kind` + `deepLink` at the top level.
    func test_push_secretRequestWake_routesToApprovals() {
        let aps: [AnyHashable: Any] = ["category": "secret-request", "alert": ["title": "Flagship"]]
        XCTAssertEqual(
            PushNotifications.link(forPush: ["aps": aps, "flagship-sealed": "", "kind": "secret-request",
                                             "deepLink": "https://\(host)/app/secret-requests"]),
            .secretRequests)
        XCTAssertEqual(PushNotifications.link(forPush: ["aps": aps, "flagship-sealed": ""]), .secretRequests)
        XCTAssertEqual(
            PushNotifications.link(forPush: ["aps": aps, "kind": PushNotifications.shareStartupKind]),
            .sharedWithMe)
    }

    // Category-only notices name no server: a tap opens the app and nothing more.
    func test_push_accountNotices_openTheAppOnly() {
        for category in ["cert-alert", "server-registered"] {
            XCTAssertTrue(PushNotifications.accountNoticeCategories.contains(category))
            XCTAssertNil(PushNotifications.link(forPush: ["aps": ["category": category], "flagship-sealed": ""]))
        }
    }

    // MARK: - In-process delivery (App Intents)

    @MainActor
    func test_deliver_reachesTheCurrentLinker() {
        let linker = DeepLinker()
        linker.makeCurrent()
        DeepLinker.deliver(.secretRequests)
        XCTAssertEqual(linker.consume(), .secretRequests)
    }

    @MainActor
    func test_deliver_beforeAnyLinker_waitsForOne() {
        do {
            let gone = DeepLinker()
            gone.makeCurrent()
        }
        DeepLinker.deliver(.serverDetail(podId: "p1"))
        let linker = DeepLinker()
        XCTAssertNil(linker.pending)
        linker.makeCurrent()
        XCTAssertEqual(linker.consume(), .serverDetail(podId: "p1"))
    }
}
