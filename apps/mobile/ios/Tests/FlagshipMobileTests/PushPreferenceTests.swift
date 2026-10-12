import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Settings → Privacy → "Push notifications" (docs/ai-privacy-and-staging.md
/// §3a): on by default, stored on the device; off drops the `.com` push
/// registration, tells every box to push no access alert, and shows no access
/// sheet.
@MainActor
final class PushPreferenceTests: XCTestCase {

    private func box(_ pod: String, enabled: Bool? = true) -> (AppAccessAlertCenter.Box, MockScreensClient) {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.podContext = pod
        c.mockAccessAlertsEnabled = enabled
        return (AppAccessAlertCenter.Box(serverDomain: "\(pod).bright-maple.flagship.services", client: c), c)
    }

    /// Stands in for the PushRegistrar + UIApplication pair.
    private final class FakeRegistration {
        var server = true
        var apns = true
        var serverFails = false
        var log: [String] = []

        var registration: PushPreferenceSync.Registration {
            .init(
                registerAPNs: { self.log.append("apns-register"); self.apns = true },
                unregisterAPNs: { self.log.append("apns-unregister"); self.apns = false },
                unregisterServer: {
                    self.log.append("server-unregister")
                    if !self.serverFails { self.server = false }
                },
                isRegistered: { self.server || self.apns })
        }
    }

    private func sync(_ boxes: [AppAccessAlertCenter.Box], on: @escaping @MainActor () -> Bool,
                      _ reg: FakeRegistration) -> PushPreferenceSync {
        PushPreferenceSync(boxes: { boxes }, isEnabled: on, registration: reg.registration)
    }

    func test_onByDefault_andStoredOnTheDevice() {
        let defaults = UserDefaults(suiteName: "push-\(UUID().uuidString)")!
        XCTAssertTrue(PrivacySettings(defaults: defaults).pushNotificationsEnabled)
        PrivacySettings(defaults: defaults).pushNotificationsEnabled = false
        XCTAssertFalse(PrivacySettings(defaults: defaults).pushNotificationsEnabled)
        XCTAssertEqual(PushPreferenceCopy.title, "Push notifications")
    }

    func test_toggle_writesEveryBox_andRegistersOrUnregisters() async {
        let (home, homeClient) = box("home")
        let (home2, home2Client) = box("home2")
        let (old, oldClient) = box("old", enabled: nil)
        var on = false
        let reg = FakeRegistration()
        let prefs = sync([home, old, home2], on: { on }, reg)

        await prefs.changed()
        XCTAssertEqual(homeClient.setAccessAlertsCalls, [false])
        XCTAssertEqual(home2Client.setAccessAlertsCalls, [false])
        XCTAssertEqual(oldClient.setAccessAlertsCalls, [false])
        XCTAssertEqual(homeClient.mockAccessAlertsEnabled, false)
        XCTAssertEqual(home2Client.mockAccessAlertsEnabled, false)
        XCTAssertNil(oldClient.mockAccessAlertsEnabled)
        XCTAssertEqual(reg.log, ["server-unregister", "apns-unregister"])
        XCTAssertFalse(reg.server)
        XCTAssertFalse(reg.apns)

        on = true
        await prefs.changed()
        XCTAssertEqual(homeClient.setAccessAlertsCalls, [false, true])
        XCTAssertEqual(home2Client.mockAccessAlertsEnabled, true)
        XCTAssertEqual(reg.log.last, "apns-register")
    }

    func test_off_dropsAPNsEvenWhenTheRevokeFails_andRetriesTheRevokeNextStart() async {
        let (home, homeClient) = box("home")
        let reg = FakeRegistration()
        reg.serverFails = true
        let prefs = sync([home], on: { false }, reg)

        await prefs.changed()
        XCTAssertEqual(homeClient.setAccessAlertsCalls, [false])
        XCTAssertEqual(reg.log, ["server-unregister", "apns-unregister"])
        XCTAssertTrue(reg.server)
        XCTAssertFalse(reg.apns)

        reg.serverFails = false
        await prefs.resync()
        XCTAssertEqual(reg.log, ["server-unregister", "apns-unregister", "server-unregister", "apns-unregister"])
        XCTAssertFalse(reg.server)

        await prefs.resync()
        XCTAssertEqual(reg.log.count, 4)
    }

    func test_off_withTheRealRegistrar_revokesOnCom() async throws {
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "test")
        let deviceId = "00112233445566778899aabbccddeeff"
        let state = AppState(isPaired: true, currentUser: "harry",
                             profiles: [Profile(cloudName: "harry", accountId: "harry", deviceId: deviceId)],
                             activeProfileCloudName: "harry")
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        var on = true
        let registrar = PushRegistrar(appState: state, client: server, isEnabled: { on })
        await registrar.handle(deviceToken: Data(repeating: 0x66, count: 32))
        XCTAssertEqual(server.registeredPushTokens.count, 1)

        var apnsDropped = false
        let (home, homeClient) = box("home")
        let prefs = PushPreferenceSync(
            boxes: { [home] }, isEnabled: { on },
            registration: .init(
                registerAPNs: {}, unregisterAPNs: { apnsDropped = true },
                unregisterServer: { _ = await registrar.unregister() },
                isRegistered: { registrar.isRegistered }))
        on = false
        await prefs.changed()
        XCTAssertEqual(server.registeredPushTokens.count, 0)
        XCTAssertFalse(registrar.isRegistered)
        XCTAssertTrue(apnsDropped)
        XCTAssertEqual(homeClient.mockAccessAlertsEnabled, false)
        // A token APNs still hands over while off isn't registered.
        await registrar.handle(deviceToken: Data(repeating: 0x67, count: 32))
        XCTAssertEqual(server.registeredPushTokens.count, 0)
    }

    func test_resync_fixesOnlyTheBoxesThatDisagree_andSkipsOlderBoxes() async {
        let (agrees, agreesClient) = box("home", enabled: false)
        let (differs, differsClient) = box("home2", enabled: true)
        let (old, oldClient) = box("old", enabled: nil)
        let reg = FakeRegistration()
        reg.apns = false
        let prefs = sync([agrees, old, differs], on: { false }, reg)

        await prefs.resync()
        XCTAssertEqual(agreesClient.accessAlertsSettingCalls, 1)
        XCTAssertTrue(agreesClient.setAccessAlertsCalls.isEmpty)
        XCTAssertEqual(differsClient.setAccessAlertsCalls, [false])
        XCTAssertEqual(oldClient.accessAlertsSettingCalls, 1)
        XCTAssertTrue(oldClient.setAccessAlertsCalls.isEmpty)
        // Off but still registered on .com (an earlier revoke that failed).
        XCTAssertEqual(reg.log, ["server-unregister", "apns-unregister"])

        await prefs.resync()
        XCTAssertEqual(differsClient.setAccessAlertsCalls, [false])
        XCTAssertEqual(reg.log.count, 2)
    }

    func test_resync_whenOn_leavesTheRegistrationAlone() async {
        let (home, homeClient) = box("home", enabled: false)
        let reg = FakeRegistration()
        await sync([home], on: { true }, reg).resync()
        XCTAssertEqual(homeClient.setAccessAlertsCalls, [true])
        XCTAssertTrue(reg.log.isEmpty)
    }

    func test_off_showsNoAccessSheets_butTheRequestsStayOnTheBox() async {
        let (home, client) = box("home")
        var on = true
        let center = AppAccessAlertCenter(
            boxes: { [home] }, alertsEnabled: { on }, signer: { _ in Curve25519.Signing.PrivateKey() },
            defaults: UserDefaults(suiteName: "access-\(UUID().uuidString)")!)
        await center.refresh()
        XCTAssertEqual(center.current?.request?.host, "api.open-meteo.com")

        on = false
        await center.refresh()
        XCTAssertNil(center.current)
        XCTAssertTrue(center.queue.isEmpty)
        let calls = client.accessRequestsCalls
        AppAccessEvents.post()
        center.observeEvents()
        AppAccessEvents.post()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertNil(center.current)
        XCTAssertEqual(client.accessRequestsCalls, calls)
        XCTAssertEqual(client.mockAccess["bright-maple--plants"]?.pending.count, 2)

        on = true
        await center.refresh()
        XCTAssertEqual(center.current?.request?.host, "api.open-meteo.com")
    }

    func test_genericPushRefreshesTheRequests() async throws {
        let (home, _) = box("home")
        let center = AppAccessAlertCenter(
            boxes: { [home] }, signer: { _ in Curve25519.Signing.PrivateKey() },
            defaults: UserDefaults(suiteName: "access-\(UUID().uuidString)")!)
        center.observeEvents()
        let push: [AnyHashable: Any] = ["aps": ["category": "generic", "alert": ["title": "Flagship"]]]
        XCTAssertTrue(AppAccessEvents.isPush(push))
        if AppAccessEvents.isPush(push) { AppAccessEvents.post() }
        for _ in 0..<100 where center.current == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(center.current?.request?.host, "api.open-meteo.com")
    }

    func test_liveClient_talksToTheSettingsPath() async throws {
        var seen: [(method: String, path: String, session: String?, body: Data?)] = []
        StubURLProtocol.handler = { req in
            var body = req.httpBody
            if body == nil, let stream = req.httpBodyStream {
                stream.open(); defer { stream.close() }
                var d = Data()
                var buf = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable {
                    let n = stream.read(&buf, maxLength: buf.count)
                    if n <= 0 { break }
                    d.append(buf, count: n)
                }
                body = d
            }
            seen.append((req.httpMethod ?? "", req.url?.path ?? "", req.value(forHTTPHeaderField: "x-flagship-session"), body))
            let json = req.httpMethod == "POST" ? #"{"ok":true,"enabled":false}"# : #"{"enabled":true}"#
            return (HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
        }
        defer { StubURLProtocol.handler = nil }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        let client = LiveScreensClient(
            urlSession: URLSession(configuration: cfg),
            store: PodScopedSessionStore(baseUrl: "https://home.bright-maple.flagship.services", token: "ab12"))

        let current = try await client.accessAlertsSetting()
        XCTAssertEqual(current.enabled, true)
        let set = try await client.setAccessAlerts(enabled: false)
        XCTAssertEqual(set, AccessAlertsSetting(enabled: false, ok: true))

        XCTAssertEqual(seen.map(\.method), ["GET", "POST"])
        XCTAssertEqual(seen.map(\.path), ["/api/screens/settings/access-alerts", "/api/screens/settings/access-alerts"])
        XCTAssertEqual(seen.map(\.session), ["ab12", "ab12"])
        let sent = try XCTUnwrap(seen.last?.body)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: sent) as? [String: Bool], ["enabled": false])
    }
}
