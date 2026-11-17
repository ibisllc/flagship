import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship
@testable import FlagshipAPI

/// The outbound proxy on iOS (docs/outbound-proxy.md): the recipe siblings,
/// the create-flow fields, and the server page's signed changes.
@MainActor
final class OutboundProxyTests: XCTestCase {
    private let key = Curve25519.Signing.PrivateKey()

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.podContext = "home"
        return c
    }

    private func controller(_ client: MockScreensClient, summary: OutboundProxySummary? = nil) -> OutboundProxyController {
        let key = self.key
        return OutboundProxyController(
            serverDomain: "home.bright-maple.flagship.services",
            summary: summary,
            client: client,
            signer: { _ in key },
            now: { 1_760_000_000_000 }
        )
    }

    private func verified(_ req: OutboundProxySetRequest) throws -> Bool {
        key.publicKey.isValidSignature(try XCTUnwrap(HexUtil.decode(req.signature)),
                                       for: try BoxProxy(req.proxy).canonicalBytes())
    }

    func test_saveSignsTheOrderForThisBoxAndSendsCredentialsBeside() async throws {
        let client = makeClient()
        let vm = controller(client)
        vm.beginEdit()
        vm.kind = .http
        XCTAssertEqual(vm.port, "3128", "switching kind moves the default port")
        vm.host = "  Proxy.Example.NET "
        vm.username = "alice"
        vm.password = "pw"
        XCTAssertNil(vm.fieldError)
        let ok = await vm.save()
        XCTAssertTrue(ok)
        let req = try XCTUnwrap(client.outboundProxySetCalls.first)
        XCTAssertEqual(req.proxy.serverDomain, "home.bright-maple.flagship.services")
        XCTAssertEqual(req.proxy.kind, "http")
        XCTAssertEqual(req.proxy.host, "proxy.example.net")
        XCTAssertEqual(req.proxy.port, 3128)
        XCTAssertTrue(req.proxy.auth)
        XCTAssertEqual(req.credentials, BoxProxyCredentials(username: "alice", password: "pw"))
        XCTAssertTrue(try verified(req))
        XCTAssertEqual(vm.savedMessage, OutboundProxyCopy.savedOn)
        XCTAssertEqual(vm.summary?.proxy?.host, "proxy.example.net")
    }

    func test_anUnchangedProxyKeepsTheBoxsPassword() async throws {
        let client = makeClient()
        let summary = OutboundProxySummary(
            proxy: .init(kind: "socks5", host: "proxy.example.net", port: 1080, auth: true, fallbackDirect: false, issuedAt: 1),
            hasCredentials: true, status: .init(state: "ok", since: 1))
        let vm = controller(client, summary: summary)
        vm.beginEdit()
        XCTAssertTrue(vm.keepsCredentials)
        vm.fallbackDirect = true
        _ = await vm.save()
        let req = try XCTUnwrap(client.outboundProxySetCalls.first)
        XCTAssertTrue(req.proxy.auth)
        XCTAssertNil(req.credentials, "no credentials ⇒ the box keeps its own")
        XCTAssertTrue(req.proxy.fallbackDirect)
        let json = String(decoding: try JSONEncoder().encode(req), as: UTF8.self)
        XCTAssertFalse(json.contains("credentials"))

        vm.beginEdit()
        vm.host = "other.example.net"
        XCTAssertFalse(vm.keepsCredentials, "a different proxy doesn't inherit the password")
    }

    func test_turnOffSendsKindNone() async throws {
        let client = makeClient()
        let vm = controller(client)
        let ok = await vm.turnOff()
        XCTAssertTrue(ok)
        let req = try XCTUnwrap(client.outboundProxySetCalls.first)
        XCTAssertEqual(req.proxy.kind, "none")
        XCTAssertEqual(req.proxy.host, "")
        XCTAssertEqual(req.proxy.port, 0)
        XCTAssertFalse(req.proxy.auth)
        XCTAssertTrue(try verified(req))
        XCTAssertEqual(vm.savedMessage, OutboundProxyCopy.savedOff)
    }

    func test_showsTheBoxsReasonWhenItRefuses() async {
        let client = makeClient()
        client.outboundProxySetError = ScreensClientError.http(status: 422, message: #"{"error":"Can't reach the proxy."}"#)
        let vm = controller(client)
        vm.beginEdit()
        vm.host = "10.0.0.2"
        let ok = await vm.save()
        XCTAssertFalse(ok)
        XCTAssertEqual(vm.errorMessage, "Can't reach the proxy.")
    }

    func test_formRules() {
        XCTAssertNil(OutboundProxyForm.error(kind: .none, host: "", port: "", username: "", password: ""))
        XCTAssertEqual(OutboundProxyForm.error(kind: .socks5, host: "", port: "1080", username: "", password: ""),
                       "Enter the proxy's address.")
        XCTAssertEqual(OutboundProxyForm.error(kind: .socks5, host: "socks5://x.net", port: "1080", username: "", password: ""),
                       "Use a host name or an IP address, without a scheme, path or port.")
        XCTAssertEqual(OutboundProxyForm.error(kind: .http, host: "x.net", port: "99999", username: "", password: ""),
                       "Enter a port from 1 to 65535.")
        XCTAssertEqual(OutboundProxyForm.error(kind: .http, host: "x.net", port: "3128", username: "a", password: ""),
                       "Enter both the username and the password, or neither.")
        XCTAssertEqual(OutboundProxyForm.error(kind: .http, host: "x.net", port: "3128", username: "a:b", password: "c"),
                       "The username can't contain a colon.")
    }

    func test_summaryAndStatusLines() {
        XCTAssertEqual(OutboundProxyCopy.summaryLine(nil), "Off")
        XCTAssertEqual(OutboundProxyCopy.summaryLine(.init(kind: "socks5", host: "2001:db8::7", port: 9050, auth: true,
                                                           fallbackDirect: false, issuedAt: 1)),
                       "SOCKS5 · [2001:db8::7]:9050 · needs a password")
        XCTAssertNil(OutboundProxyCopy.statusLine(.init(state: "direct", since: 0)))
        XCTAssertEqual(OutboundProxyCopy.statusLine(.init(state: "failing", since: 0, lastError: "box English", code: "auth")),
                       "The outbound proxy isn't working: The proxy refused the username or password.")
        XCTAssertEqual(OutboundProxyCopy.statusLine(.init(state: "fallback", since: 0)),
                       "The outbound proxy isn't working, so this server is connecting directly: Can't reach the proxy.")
    }

    // MARK: failure codes, /pods alerts and the .com lane

    func test_codeToSentence() {
        XCTAssertEqual(OutboundProxyCopy.reason(code: "unreachable"), "Can't reach the proxy.")
        XCTAssertEqual(OutboundProxyCopy.reason(code: "auth"), "The proxy refused the username or password.")
        XCTAssertEqual(OutboundProxyCopy.reason(code: "refused"), "The proxy refused the connection.")
        XCTAssertEqual(OutboundProxyCopy.reason(code: "protocol"), "The proxy gave an answer the server doesn't understand.")
        XCTAssertEqual(OutboundProxyCopy.reason(code: nil), "Can't reach the proxy.")
        XCTAssertEqual(OutboundProxyCopy.reason(code: "new-one"), "Can't reach the proxy.")
        XCTAssertEqual(OutboundProxyCopy.alertLine(state: "failing", code: "refused"),
                       "The outbound proxy isn't working: The proxy refused the connection.")
        XCTAssertNil(OutboundProxyCopy.alertLine(state: "ok", code: nil))
        XCTAssertNil(OutboundProxyCopy.alertLine(state: "direct", code: "auth"))
    }

    func test_statusAndPodsAlertDecodeTolerantly() throws {
        let s = try JSONDecoder().decode(OutboundProxySummary.Status.self, from: Data(#"{"state":"failing","since":5,"code":"protocol"}"#.utf8))
        XCTAssertEqual(s.code, "protocol")
        let old = try JSONDecoder().decode(OutboundProxySummary.Status.self, from: Data(#"{"state":"ok","since":5,"code":7}"#.utf8))
        XCTAssertNil(old.code)
        let pod = #"{"serverDomain":"home.u.flagship.services","identityPubKey":"aa","proxyAlert":{"state":"failing","code":"auth","since":9}}"#
        let a = try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(pod.utf8))
        XCTAssertEqual(a.proxyAlert, ProxyAlertWire(state: "failing", code: "auth", since: 9))
        let bad = #"{"serverDomain":"h","identityPubKey":"aa","proxyAlert":"yes"}"#
        XCTAssertNil(try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(bad.utf8)).proxyAlert)
        let unknown = #"{"serverDomain":"h","identityPubKey":"aa","proxyAlert":{"state":"weird"}}"#
        XCTAssertNil(try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(unknown.utf8)).proxyAlert)
        let none = #"{"serverDomain":"h","identityPubKey":"aa"}"#
        XCTAssertNil(try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(none.utf8)).proxyAlert)
    }

    func test_laneDecision() {
        XCTAssertTrue(OutboundProxyLane.allows(credentials: nil))
        XCTAssertFalse(OutboundProxyLane.allows(credentials: BoxProxyCredentials(username: "a", password: "b")))
        XCTAssertTrue(OutboundProxyLane.boxUnreachable(URLError(.timedOut)))
        XCTAssertTrue(OutboundProxyLane.boxUnreachable(URLError(.cannotConnectToHost)))
        XCTAssertTrue(OutboundProxyLane.boxUnreachable(ScreensClientError.http(status: 502, message: "")))
        XCTAssertFalse(OutboundProxyLane.boxUnreachable(ScreensClientError.http(status: 422, message: #"{"error":"Can't reach the proxy."}"#)))
        XCTAssertFalse(OutboundProxyLane.boxUnreachable(ScreensClientError.http(status: 400, message: "")))
    }

    private func laneController(_ client: MockScreensClient, _ server: MockFlagshipServerClient, summary: OutboundProxySummary? = nil,
                                unreachable: Bool) -> OutboundProxyController {
        let key = self.key
        return OutboundProxyController(serverDomain: "home.bright-maple.flagship.services", summary: summary, client: client,
                                       lane: server, boxUnreachable: unreachable, signer: { _ in key }, now: { 1_760_000_000_000 })
    }

    func test_aTimeoutSendsTheSameSignedOrderThroughTheLane() async throws {
        let client = makeClient()
        client.outboundProxySetError = URLError(.timedOut)
        let server = MockFlagshipServerClient()
        let vm = laneController(client, server, unreachable: false)
        let ok = await vm.turnOff()
        XCTAssertTrue(ok)
        XCTAssertTrue(vm.sentByLane)
        XCTAssertEqual(vm.savedMessage, OutboundProxyCopy.laneSent)
        let sent = try XCTUnwrap(server.proxyLaneCalls.first)
        XCTAssertEqual(sent.serverDomain, "home.bright-maple.flagship.services")
        XCTAssertEqual(sent.req.proxy, client.outboundProxySetCalls.first?.proxy)
        XCTAssertEqual(sent.req.signature, client.outboundProxySetCalls.first?.signature)
        XCTAssertTrue(key.publicKey.isValidSignature(try XCTUnwrap(HexUtil.decode(sent.req.signature)), for: try BoxProxy(sent.req.proxy).canonicalBytes()))
        // The lane's body never names credentials.
        let body = String(decoding: try JSONEncoder().encode(sent.req), as: UTF8.self)
        XCTAssertFalse(body.contains("credentials"))
    }

    func test_aBoxAnswerIsNotRetriedThroughTheLane() async {
        let client = makeClient()
        client.outboundProxySetError = ScreensClientError.http(status: 422, message: #"{"error":"Can't reach the proxy."}"#)
        let server = MockFlagshipServerClient()
        let vm = laneController(client, server, unreachable: false)
        vm.beginEdit()
        vm.host = "10.0.0.2"
        let ok = await vm.save()
        XCTAssertFalse(ok)
        XCTAssertTrue(server.proxyLaneCalls.isEmpty)
    }

    func test_offlineBoxGoesStraightToTheLaneAndKeepsThePassword() async throws {
        let client = makeClient()
        let server = MockFlagshipServerClient()
        let summary = OutboundProxySummary(proxy: .init(kind: "socks5", host: "proxy.example.net", port: 1080, auth: true, fallbackDirect: false, issuedAt: 1),
                                           hasCredentials: true, status: .init(state: "failing", since: 1, code: "unreachable"))
        let vm = laneController(client, server, summary: summary, unreachable: true)
        vm.beginEdit()
        vm.fallbackDirect = true
        XCTAssertTrue(vm.keepsCredentials)
        let ok = await vm.save()
        XCTAssertTrue(ok)
        XCTAssertTrue(client.outboundProxySetCalls.isEmpty, "Nothing goes to the unreachable box.")
        let sent = try XCTUnwrap(server.proxyLaneCalls.first)
        XCTAssertTrue(sent.req.proxy.auth, "The same proxy keeps the password the box holds.")
        XCTAssertTrue(sent.req.proxy.fallbackDirect)
    }

    func test_laneRefusesANewPasswordBeforeSigning() async {
        let client = makeClient()
        let server = MockFlagshipServerClient()
        var prompted = false
        let key = self.key
        let vm = OutboundProxyController(serverDomain: "home.bright-maple.flagship.services", summary: nil, client: client, lane: server,
                                         boxUnreachable: true, signer: { _ in prompted = true; return key })
        vm.beginEdit()
        vm.host = "proxy.example.net"
        vm.username = "alice"
        vm.password = "new"
        let ok = await vm.save()
        XCTAssertFalse(ok)
        XCTAssertFalse(prompted, "No biometric for an order the lane can't carry.")
        XCTAssertEqual(vm.errorMessage, OutboundProxyCopy.laneNoPassword)
        XCTAssertTrue(server.proxyLaneCalls.isEmpty)

        // Reachable box, timeout, new password: refused too, nothing to .com.
        let client2 = makeClient()
        client2.outboundProxySetError = URLError(.timedOut)
        let server2 = MockFlagshipServerClient()
        let vm2 = laneController(client2, server2, unreachable: false)
        vm2.beginEdit()
        vm2.host = "proxy.example.net"
        vm2.username = "alice"
        vm2.password = "new"
        let ok2 = await vm2.save()
        XCTAssertFalse(ok2)
        XCTAssertEqual(vm2.errorMessage, OutboundProxyCopy.laneNoPassword)
        XCTAssertTrue(server2.proxyLaneCalls.isEmpty)
    }

    func test_planScreenPrivacyLines() {
        XCTAssertEqual(PlanDisplay.privacyLine(.relayWaiting),
                       "The private relay isn't answering. Payments wait and try again; your plan stays active meanwhile.")
        XCTAssertEqual(PlanDisplay.privacyLine(.wentDirect),
                       "The private relay wasn't answering, so the last payment went straight to Flagship.")
        XCTAssertEqual(PlanDisplay.privacyLine(.thirdPartyRelay(operator: "Example Relay Co")),
                       "Payments go through Example Relay Co's private relay, so Flagship doesn't see your network address when you pay.")
        XCTAssertEqual(PlanDisplay.privacyLine(.interimRelay),
                       "Payments go through a private relay that Flagship runs for now. It keeps your address out of the payment logs, but it isn't an independent operator yet.")
        XCTAssertEqual(PlanDisplay.privacyLine(.noRelay), "Flagship can see your network address when you pay. It keeps none of it.")
    }

    func test_serverDetailDecodesTheSummaryAndToleratesOlderBoxes() throws {
        let base = #"{"serverFqdn":"h","username":"u","daemonVersion":"1","currentCommit":null,"startedAt":0,"uptimeMs":0,"serviceCount":0,"pairedSessionCount":0,"recentInstallEvents":[]"#
        let old = try JSONDecoder().decode(ServerDetailResponse.self, from: Data((base + "}").utf8))
        XCTAssertNil(old.outboundProxy)
        let new = try JSONDecoder().decode(ServerDetailResponse.self, from: Data((base + #","outboundProxy":{"proxy":{"kind":"http","host":"10.0.0.2","port":3128,"auth":false,"fallbackDirect":true,"issuedAt":5},"hasCredentials":false,"status":{"state":"failing","since":9,"lastError":"Can't reach the proxy."}}}"#).utf8))
        XCTAssertEqual(new.outboundProxy?.proxy?.port, 3128)
        XCTAssertEqual(new.outboundProxy?.status.lastError, "Can't reach the proxy.")
    }

    // MARK: - Create flow

    private func makeCreateVM() -> CreateServerViewModel {
        CreateServerViewModel(username: "harry", server: MockFlagshipServerClient(), relay: MockQrRelayClient(), isDemoAccount: false)
    }

    func test_createFlowBlocksABadProxyAndResetsWithAdvanced() {
        let vm = makeCreateVM()
        vm.name = "home"
        XCTAssertTrue(vm.canAdvanceFromDesign)
        vm.advancedMode = true
        vm.proxyKind = .socks5
        XCTAssertEqual(vm.proxyPort, "1080")
        XCTAssertFalse(vm.canAdvanceFromDesign, "an empty proxy address blocks Continue")
        vm.proxyHost = "192.168.1.20"
        XCTAssertTrue(vm.canAdvanceFromDesign)
        vm.advancedMode = false
        XCTAssertEqual(vm.proxyKind, .none)
    }

    func test_aFreeAccountSeesTheProNoteAndNoProxyBlocksContinue() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.accountTierAnswer = "free"
        let vm = CreateServerViewModel(username: "harry", server: server, relay: MockQrRelayClient(), isDemoAccount: false)
        vm.name = "home"
        XCTAssertTrue(vm.proxyAllowed, "an unknown plan doesn't block")
        await vm.loadAccountTier()
        XCTAssertFalse(vm.proxyAllowed)
        vm.advancedMode = true
        vm.proxyKind = .socks5
        XCTAssertNil(vm.proxyError)
        XCTAssertTrue(vm.canAdvanceFromDesign)

        server.accountTierAnswer = "hobby"
        await vm.loadAccountTier()
        XCTAssertTrue(vm.proxyAllowed)
        XCTAssertFalse(vm.canAdvanceFromDesign)
        XCTAssertTrue(OutboundProxyCopy.allowed(tier: "maker"))
        XCTAssertFalse(OutboundProxyCopy.allowed(tier: "free"))
        XCTAssertEqual(OutboundProxyCopy.proNote, "An outbound proxy is part of Pro.")
    }

    func test_theBoxSaysWhenTheProxyIsntAvailable() throws {
        let json = #"{"proxy":null,"hasCredentials":false,"status":{"state":"direct","since":1},"available":false}"#
        let s = try JSONDecoder().decode(OutboundProxySummary.self, from: Data(json.utf8))
        XCTAssertEqual(s.available, false)
        let older = try JSONDecoder().decode(OutboundProxySummary.self, from: Data(#"{"proxy":null,"hasCredentials":false,"status":{"state":"direct","since":1}}"#.utf8))
        XCTAssertNil(older.available)
    }

    func test_recipeCarriesTheSignedOrderAndOnlyTypedCredentials() throws {
        let order = BoxProxy.make(serverDomain: "home.harry.flagship.services", kind: .socks5, host: "proxy.example.net",
                                  port: 1080, auth: true, fallbackDirect: false, now: 5, nonce: Data(repeating: 1, count: 32))
        let blob = InstallBlob(
            serverDomain: "home.harry.flagship.services", username: "harry", serverName: "home",
            phoneDelegatedPubKey: Data(repeating: 1, count: 32),
            authCode: AuthCode(serial: "S", username: "harry", serverName: "home",
                               serverDomain: "home.harry.flagship.services",
                               delegatedPubKey: Data(repeating: 1, count: 32), userPubKey: key.publicKey.rawRepresentation,
                               issuedAt: 1, expiresAt: 2),
            authCodeUserSignature: Data(repeating: 0, count: 64),
            rckPubKey: Data(repeating: 2, count: 32)
        )
        let wire = SignedBoxProxyWire(proxy: order.fields, signature: try order.sign(with: key))
        let signed = SignedInstallBlob(blob: blob, signatureHex: "ab", outboundProxy: wire,
                                       outboundProxyCredentials: BoxProxyCredentials(username: "alice", password: "pw"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(signed.onWire())) as? [String: Any])
        let proxy = try XCTUnwrap(obj["outboundProxy"] as? [String: Any])
        XCTAssertEqual((proxy["proxy"] as? [String: Any])?["host"] as? String, "proxy.example.net")
        XCTAssertEqual((obj["outboundProxyCredentials"] as? [String: Any])?["username"] as? String, "alice")

        let plain = SignedInstallBlob(blob: blob, signatureHex: "ab")
        let plainObj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(plain.onWire())) as? [String: Any])
        XCTAssertNil(plainObj["outboundProxy"])
        XCTAssertNil(plainObj["outboundProxyCredentials"])
    }
}
