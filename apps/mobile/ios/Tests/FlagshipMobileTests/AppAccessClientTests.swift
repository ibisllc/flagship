import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipUI
import FlagshipCore

/// docs/ai-privacy-and-staging.md §3a on iOS: the "Internet access" section,
/// the list editor, the app-wide "<App> wants to reach <host>" alerts, and
/// the grant naming the box it goes to.
@MainActor
final class AppAccessClientTests: XCTestCase {

    private func makeClient(pod: String = "home") -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.podContext = pod
        return c
    }

    private func hex(_ s: String) -> Data { HexUtil.decode(s)! }

    private func verified(_ key: Curve25519.Signing.PrivateKey, _ req: AppAccessSetRequest) -> Bool {
        key.publicKey.isValidSignature(hex(req.signature), for: req.grant.canonicalBytes())
    }

    // MARK: - Models

    func test_summaryAndRequestsDecode() throws {
        let base = #""serviceId":"a--b","creator":"a","slug":"b","urlLabel":"b","url":"https://b","status":"running","installedAt":1"#
        let old = try JSONDecoder().decode(AppSummary.self, from: Data("{\(base)}".utf8))
        XCTAssertNil(old.access)
        let counts = try JSONDecoder().decode(AppSummary.self, from: Data("{\(base),\"access\":{\"rules\":3,\"pending\":2}}".utf8))
        XCTAssertEqual(counts.access, AppAccessSummary(rules: 3, pending: 2))
        XCTAssertEqual(counts.access?.hasPending, true)
        let list = try JSONDecoder().decode(AppSummary.self, from: Data(
            "{\(base),\"access\":{\"rules\":0,\"pending\":[{\"host\":\"x.com\"}]}}".utf8))
        XCTAssertEqual(list.access?.pending, 1)

        let state = try JSONDecoder().decode(AppAccessState.self, from: Data(
            #"{"list":"allow a.com\n","listSha256":"ab","pending":[{"host":"b.com","source":"attempt","attempts":2,"firstSeen":1,"lastSeen":5}]}"#.utf8))
        XCTAssertEqual(state.ruleCount, 1)
        XCTAssertEqual(state.pending.first?.attempts, 2)
        let reqs = try JSONDecoder().decode(AppAccessRequestsResponse.self, from: Data(
            #"{"requests":[{"serviceId":"a--b","appName":"Weather","host":"api.x.com","source":"app","attempts":0,"firstSeen":1,"lastSeen":1}]}"#.utf8))
        XCTAssertEqual(reqs.requests.first?.appName, "Weather")
        let refusal = AppAccessRefusal.decode(#"{"error":"bad list","errors":[{"line":2,"message":"one host per line"}]}"#)
        XCTAssertEqual(refusal?.errors, [AppAccessLineError(line: 2, message: "one host per line")])
    }

    func test_copy() {
        XCTAssertEqual(AppAccessCopy.wantsToReach(app: "Weather", host: "api.open-meteo.com"),
                       "Weather wants to reach api.open-meteo.com")
        XCTAssertEqual(AppAccessCopy.answered(app: "Weather", host: "a.com", action: .allow), "Weather can now reach a.com")
        XCTAssertEqual(AppAccessCopy.answered(app: "Weather", host: "a.com", action: .deny), "Weather won't reach a.com")
        XCTAssertEqual(AppAccessCopy.source("app", attempts: 0), "Asked at install")
        XCTAssertEqual(AppAccessCopy.source("attempt", attempts: 1), "Tried to connect")
        XCTAssertEqual(AppAccessCopy.source("attempt", attempts: 4), "Tried to connect 4 times")
        XCTAssertEqual(AppAccessCopy.pushBody, "One of your apps wants to reach the internet")
        XCTAssertEqual(AppAccessCopy.ruleCount(1), "1 rule")
        XCTAssertEqual(AppAccessCopy.lineError(AppAccessLineError(line: 3, message: "one host per line")),
                       "Line 3: one host per line")
    }

    func test_pushAndFrameDetection() {
        XCTAssertTrue(AppAccessEvents.isPush([:], categoryIdentifier: "app-access"))
        XCTAssertTrue(AppAccessEvents.isPush(["aps": ["category": "app-access"]]))
        XCTAssertTrue(AppAccessEvents.isPush(["category": "app-access"]))
        XCTAssertFalse(AppAccessEvents.isPush(["kind": "secret-request"], categoryIdentifier: "secret-request"))
        XCTAssertTrue(AppAccessEvents.isRequestFrame(Data(#"{"type":"access-request","serviceId":"a--b"}"#.utf8)))
        XCTAssertFalse(AppAccessEvents.isRequestFrame(Data(#"{"kind":"token","text":"x"}"#.utf8)))
    }

    // MARK: - The service page section

    private func controller(_ client: MockScreensClient, key: Curve25519.Signing.PrivateKey,
                            serviceId: String = "bright-maple--plants",
                            fallback: String? = "home.bright-maple.flagship.services") -> AppAccessController {
        AppAccessController(serviceId: serviceId, appName: "Plants", client: client, serverDomain: fallback,
                            signer: { _ in key })
    }

    func test_section_loadsTheListAndPending() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        await c.load()
        XCTAssertEqual(c.access?.list, AppAccessList.defaultList)
        XCTAssertEqual(c.ruleCount, 0)
        XCTAssertEqual(c.pending.map(\.host), ["api.open-meteo.com", "tile.openstreetmap.org"])
    }

    func test_allow_putsTheRuleOnTopSignsForTheBoxAndClearsTheRequest() async throws {
        let client = makeClient(pod: "home2")
        let key = Curve25519.Signing.PrivateKey()
        client.mockAccessVerifyKey = key.publicKey.rawRepresentation
        // The fallback names the leader; the grant must name the box the
        // client talks to (home2).
        let c = controller(client, key: key, fallback: "home.bright-maple.flagship.services")
        await c.load()
        let ok = await c.answer(host: "api.open-meteo.com", action: .allow)
        XCTAssertTrue(ok, c.errorMessage ?? "")
        let call = try XCTUnwrap(client.serviceAccessSetCalls.last)
        XCTAssertEqual(call.serviceId, "bright-maple--plants")
        XCTAssertEqual(call.req.list, "allow api.open-meteo.com\n" + AppAccessList.defaultList)
        XCTAssertEqual(call.req.grant.serverDomain, "home2.bright-maple.flagship.services")
        XCTAssertEqual(call.req.grant.serviceId, "bright-maple--plants")
        XCTAssertEqual(call.req.grant.listSha256, AppAccessList.sha256Hex(call.req.list))
        XCTAssertTrue(verified(key, call.req))
        XCTAssertEqual(c.pending.map(\.host), ["tile.openstreetmap.org"])
        XCTAssertEqual(c.ruleCount, 1)
        XCTAssertEqual(c.lastAnswer?.host, "api.open-meteo.com")
    }

    func test_deny_thenAllowTheSameHost_replacesItsRule() async throws {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        await c.load()
        let r1 = await c.answer(host: "tile.openstreetmap.org", action: .deny)
        XCTAssertTrue(r1)
        XCTAssertEqual(client.mockAccess["bright-maple--plants"]?.list,
                       "deny tile.openstreetmap.org\n" + AppAccessList.defaultList)
        // A later order needs a newer issuedAt.
        try await Task.sleep(for: .milliseconds(5))
        let r2 = await c.answer(host: "tile.openstreetmap.org", action: .allow)
        XCTAssertTrue(r2)
        XCTAssertEqual(client.mockAccess["bright-maple--plants"]?.list,
                       "allow tile.openstreetmap.org\n" + AppAccessList.defaultList)
    }

    func test_ignore_dismissesWithoutChangingTheList() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        await c.load()
        let r3 = await c.ignore(host: "tile.openstreetmap.org")
        XCTAssertTrue(r3)
        XCTAssertEqual(client.serviceAccessDismissCalls.map(\.host), ["tile.openstreetmap.org"])
        XCTAssertTrue(client.serviceAccessSetCalls.isEmpty)
        XCTAssertEqual(c.pending.map(\.host), ["api.open-meteo.com"])
        XCTAssertEqual(client.mockAccess["bright-maple--plants"]?.list, AppAccessList.defaultList)
    }

    func test_answer_aStaleList409_rereadsAndRetriesOnce() async throws {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        await c.load()
        client.serviceAccessSetError = ScreensClientError.http(status: 409, message: #"{"error":"not newer"}"#)
        let r4 = await c.answer(host: "api.open-meteo.com", action: .allow)
        XCTAssertTrue(r4)
        XCTAssertEqual(client.serviceAccessSetCalls.count, 2)
    }

    func test_refusalsArePlain() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        await c.load()
        client.serviceAccessSetError = ScreensClientError.http(status: 403, message: #"{"error":"grant is for a different server"}"#)
        let r5 = await c.answer(host: "api.open-meteo.com", action: .allow)
        XCTAssertFalse(r5)
        XCTAssertEqual(c.errorMessage, "This change was signed for a different server. Reload the page and try again.")
        XCTAssertTrue(AppAccessCopy.message(for: ScreensClientError.http(status: 404, message: "{}")).contains("isn't installed"))
    }

    func test_signerRefused_sendsNothing() async {
        let client = makeClient()
        let c = AppAccessController(serviceId: "bright-maple--plants", appName: "Plants", client: client,
                                    serverDomain: nil, signer: { _ in throw Keystore.KeystoreError.unwrapFailed("cancelled") })
        await c.load()
        let r6 = await c.answer(host: "api.open-meteo.com", action: .allow)
        XCTAssertFalse(r6)
        XCTAssertTrue(client.serviceAccessSetCalls.isEmpty)
        XCTAssertTrue(c.errorMessage?.hasPrefix("Couldn't access your account key") == true)
    }

    // MARK: - Editor

    func test_editor_parsesAsYouTypeAndBlocksSaveOnErrors() async throws {
        let client = makeClient()
        let key = Curve25519.Signing.PrivateKey()
        let c = controller(client, key: key, serviceId: "bright-maple--wiki")
        await c.load()
        let editor = c.makeEditor()
        XCTAssertEqual(editor.text, "allow api.github.com\n" + AppAccessList.defaultList)
        XCTAssertEqual(editor.ruleCount, 1)
        XCTAssertTrue(editor.canSave)

        editor.text = "allow api.github.com\nallow https://x.com\ndeny\n"
        XCTAssertEqual(editor.lineErrors.map(\.line), [2, 3])
        XCTAssertFalse(editor.canSave)
        let r7 = await editor.save()
        XCTAssertFalse(r7)
        XCTAssertTrue(client.serviceAccessSetCalls.isEmpty)

        editor.text = "allow api.github.com   \r\nallow *.githubusercontent.com\r\ndeny all\r\n\r\n"
        XCTAssertTrue(editor.canSave)
        let r8 = await editor.save()
        XCTAssertTrue(r8)
        let call = try XCTUnwrap(client.serviceAccessSetCalls.last)
        XCTAssertEqual(call.req.list, "allow api.github.com\nallow *.githubusercontent.com\ndeny all\n")
        XCTAssertTrue(verified(key, call.req))
        XCTAssertEqual(c.ruleCount, 3)
        XCTAssertTrue(editor.saved)
    }

    func test_editor_showsTheBoxsLineErrors() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey(), serviceId: "bright-maple--wiki")
        await c.load()
        let editor = c.makeEditor()
        client.serviceAccessSetError = ScreensClientError.http(
            status: 400, message: #"{"error":"bad list","errors":[{"line":1,"message":"one host per line"}]}"#)
        let r9 = await editor.save()
        XCTAssertFalse(r9)
        XCTAssertEqual(editor.lineErrors, [AppAccessLineError(line: 1, message: "one host per line")])
        XCTAssertFalse(editor.canSave)
        editor.text += "allow b.com\n"
        XCTAssertTrue(editor.lineErrors.isEmpty)
        XCTAssertTrue(editor.canSave)
    }

    func test_editor_readOnlyOnARestrictedProfile() {
        let editor = AppAccessEditorModel(appName: "x", initialList: "", canSave: false) { _ in
            AppAccessState(list: "")
        }
        XCTAssertFalse(editor.canSave)
    }

    // MARK: - Service page picks the section

    func test_detail_showsTheSectionWhenTheBoxSendsAccess_elseTheV1Card() async {
        let client = makeClient()
        let vm = ServiceDetailViewModel(serviceId: "bright-maple--plants", client: client, allPods: [],
                                        globalLeaderPodId: nil, serverDomain: "home.bright-maple.flagship.services",
                                        egressSigner: { _ in Curve25519.Signing.PrivateKey() })
        await vm.load()
        XCTAssertNotNil(vm.access)
        XCTAssertFalse(vm.showsLegacyEgress)
        XCTAssertEqual(vm.access?.pending.count, 2)
        XCTAssertEqual(vm.access?.appName, "Plants")

        let older = makeClient()
        older.mockAccess = [:]
        let vm2 = ServiceDetailViewModel(serviceId: "bright-maple--plants", client: older, allPods: [],
                                         globalLeaderPodId: nil)
        await vm2.load()
        XCTAssertNil(vm2.access)
        XCTAssertTrue(vm2.showsLegacyEgress)

        let list = try? await client.appsList()
        XCTAssertEqual(list?.apps.first { $0.serviceId == "bright-maple--plants" }?.access,
                       AppAccessSummary(rules: 0, pending: 2))
    }

    func test_v1Grant_namesTheBoxTheClientTalksTo_notTheLeader() async throws {
        let client = makeClient(pod: "home2")
        client.mockAccess = [:]
        let vm = ServiceDetailViewModel(serviceId: "bright-maple--plants", client: client, allPods: [],
                                        globalLeaderPodId: nil, serverDomain: "home.bright-maple.flagship.services",
                                        egressSigner: { _ in Curve25519.Signing.PrivateKey() })
        await vm.load()
        let r10 = await vm.allowEgress(host: "api.open-meteo.com")
        XCTAssertTrue(r10)
        XCTAssertEqual(client.serviceEgressSetCalls.last?.req.grant.serverDomain, "home2.bright-maple.flagship.services")
    }

    // MARK: - App-wide alerts

    private func center(_ boxes: [AppAccessAlertCenter.Box], key: Curve25519.Signing.PrivateKey,
                        active: Bool = true, defaults: UserDefaults? = nil,
                        now: @escaping () -> Date = Date.init) -> AppAccessAlertCenter {
        AppAccessAlertCenter(boxes: { boxes }, isActive: { active }, signer: { _ in key },
                             defaults: defaults ?? UserDefaults(suiteName: "access-\(UUID().uuidString)")!, now: now)
    }

    func test_alerts_notNowHidesARequestFor24HoursOnThisDevice() async {
        let home = makeClient()
        let defaults = UserDefaults(suiteName: "access-\(UUID().uuidString)")!
        var clock = Date(timeIntervalSince1970: 1_760_000_000)
        let box = AppAccessAlertCenter.Box(serverDomain: "home.bright-maple.flagship.services", client: home)
        let first = center([box], key: Curve25519.Signing.PrivateKey(), defaults: defaults, now: { clock })
        await first.refresh()
        XCTAssertEqual(first.current?.request.host, "api.open-meteo.com")
        first.notNow()
        XCTAssertEqual(first.current?.request.host, "tile.openstreetmap.org")

        // Another launch, an hour later: still quiet about it.
        clock += 3600
        let second = center([box], key: Curve25519.Signing.PrivateKey(), defaults: defaults, now: { clock })
        await second.refresh()
        XCTAssertEqual(second.queue.map(\.request.host), ["tile.openstreetmap.org"])

        // A day later it asks again.
        clock += AppAccessAlertCenter.notNowInterval
        let third = center([box], key: Curve25519.Signing.PrivateKey(), defaults: defaults, now: { clock })
        await third.refresh()
        XCTAssertEqual(third.queue.map(\.request.host), ["api.open-meteo.com", "tile.openstreetmap.org"])
    }

    func test_alerts_collectFromEveryBox_andAnswerOnTheRightOne() async throws {
        let home = makeClient(pod: "home")
        let home2 = makeClient(pod: "home2")
        home2.mockAccess = ["bright-maple--wiki": AppAccessState(
            list: AppAccessList.defaultList,
            pending: [AppAccessPendingHost(host: "api.github.com", source: "attempt", attempts: 2)])]
        let key = Curve25519.Signing.PrivateKey()
        home2.mockAccessVerifyKey = key.publicKey.rawRepresentation
        let center = center([
            .init(serverDomain: "home.bright-maple.flagship.services", client: home),
            .init(serverDomain: "home2.bright-maple.flagship.services", client: home2),
        ], key: key)
        await center.refresh()
        XCTAssertEqual(center.queue.map(\.request.host), ["api.open-meteo.com", "tile.openstreetmap.org", "api.github.com"])
        XCTAssertEqual(center.current?.request.appName, "Plants")

        center.notNow()
        center.notNow()
        XCTAssertEqual(center.current?.request.host, "api.github.com")
        await center.allow()
        XCTAssertEqual(center.stage, .done(.allow))
        let call = try XCTUnwrap(home2.serviceAccessSetCalls.last)
        XCTAssertEqual(call.req.grant.serverDomain, "home2.bright-maple.flagship.services")
        XCTAssertEqual(call.req.list, "allow api.github.com\n" + AppAccessList.defaultList)
        XCTAssertTrue(home.serviceAccessSetCalls.isEmpty)

        await center.viewAccessList()
        XCTAssertEqual(center.editor?.text, "allow api.github.com\n" + AppAccessList.defaultList)
        center.close()
        XCTAssertNil(center.current)
        XCTAssertNil(center.editor)

        // Not now keeps the request on the box, but this device doesn't ask
        // again for a day.
        await center.refresh()
        XCTAssertNil(center.current)
        XCTAssertEqual(home.mockAccess["bright-maple--plants"]?.pending.count, 2)
    }

    func test_alerts_deny_andFailures() async {
        let home = makeClient()
        let center = center([.init(serverDomain: "home.bright-maple.flagship.services", client: home)],
                            key: Curve25519.Signing.PrivateKey())
        await center.refresh()
        await center.deny()
        XCTAssertEqual(center.stage, .done(.deny))
        XCTAssertEqual(home.mockAccess["bright-maple--plants"]?.list,
                       "deny api.open-meteo.com\n" + AppAccessList.defaultList)
        center.close()
        home.serviceAccessSetError = ScreensClientError.http(status: 404, message: "{}")
        await center.allow()
        guard case .failed(let msg) = center.stage else { return XCTFail("expected failed, got \(center.stage)") }
        XCTAssertTrue(msg.contains("isn't installed"))
    }

    func test_alerts_swipeAwayIsNotNow_andAStaleDismissalIsIgnored() async {
        let home = makeClient()
        let center = center([.init(serverDomain: "home.bright-maple.flagship.services", client: home)],
                            key: Curve25519.Signing.PrivateKey())
        await center.refresh()
        let first = center.current!.id
        center.dismissed(id: "someone-else")
        XCTAssertEqual(center.current?.id, first)
        center.dismissed(id: first)
        XCTAssertNotEqual(center.current?.id, first)
        XCTAssertEqual(center.current?.request.host, "tile.openstreetmap.org")
    }

    func test_alerts_inactiveAsksNothing() async {
        let home = makeClient()
        let center = center([.init(serverDomain: "home.bright-maple.flagship.services", client: home)],
                            key: Curve25519.Signing.PrivateKey(), active: false)
        await center.refresh()
        XCTAssertNil(center.current)
        XCTAssertEqual(home.accessRequestsCalls, 0)
    }

    func test_alerts_pushOrSocketEventRefreshes() async throws {
        let home = makeClient()
        let center = center([.init(serverDomain: "home.bright-maple.flagship.services", client: home)],
                            key: Curve25519.Signing.PrivateKey())
        center.observeEvents()
        AppAccessEvents.post()
        for _ in 0..<100 where center.current == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(center.current?.request.host, "api.open-meteo.com")

        let other = makeClient()
        let listening = self.center([.init(serverDomain: "home.bright-maple.flagship.services", client: other)],
                                    key: Curve25519.Signing.PrivateKey())
        await listening.startListening()
        try await Task.sleep(for: .milliseconds(20))
        other.emitAccessRequestEvent()
        for _ in 0..<100 where listening.current == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(listening.current?.request.host, "api.open-meteo.com")
        listening.stopListening()
    }

    // MARK: - Chat deploy carries the current key

    func test_chatDeploy_sendsTheCurrentCredentialWithItsRelaySetting() async throws {
        let client = makeClient()
        client.vibeCodeDeployStartFixture = VibeCodeDeployReply(ok: true, serviceId: "a--b", url: "https://b/")
        let cred = LlmProviderCredential(provider: "anthropic", apiKey: "sk-ant-x", relay: false)
        _ = try await VibeCodeDeployRun.run(client: client, sessionId: "vc-9", credential: cred,
                                            pollInterval: .milliseconds(1))
        XCTAssertEqual(client.vibeCodeDeployStartCredentials.last??.relay, false)
        XCTAssertEqual(client.vibeCodeDeployStartCredentials.last??.apiKey, "sk-ant-x")

        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            VibeCodeDeployRequest(background: true, credential: cred))) as? [String: Any])
        XCTAssertEqual(body["background"] as? Bool, true)
        XCTAssertEqual((body["credential"] as? [String: Any])?["relay"] as? Bool, false)
        let bare = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            VibeCodeDeployRequest(background: true, credential: nil))) as? [String: Any])
        XCTAssertNil(bare["credential"])
    }
}
