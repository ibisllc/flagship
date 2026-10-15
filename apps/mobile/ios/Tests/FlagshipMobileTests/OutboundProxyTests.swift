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
        XCTAssertEqual(OutboundProxyCopy.statusLine(.init(state: "failing", since: 0, lastError: "Can't reach the proxy.")),
                       "Not working: Can't reach the proxy.")
        XCTAssertEqual(OutboundProxyCopy.statusLine(.init(state: "fallback", since: 0)),
                       "Using a direct connection: the proxy isn't answering")
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
        CreateServerViewModel(username: "harry", server: MockFlagshipServerClient(), relay: MockQrRelayClient())
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
        let vm = CreateServerViewModel(username: "harry", server: server, relay: MockQrRelayClient())
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
