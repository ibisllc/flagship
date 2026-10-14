import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// CompanionDockViewModel: the phone side of the QR-first remote ceremony
/// (join the browser's relay session, match the code, mint a ticket on the
/// picked server, seal it to the browser) plus listing and revocation.
@MainActor
final class CompanionDockViewModelTests: XCTestCase {

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    private let home = CompanionDockViewModel.ServerChoice(fqdn: "home.alice.flagship.services", name: "home", online: true)
    private let lab = CompanionDockViewModel.ServerChoice(fqdn: "lab.alice.flagship.services", name: "lab", online: true)

    private func makeVM(
        _ client: MockScreensClient,
        relay: MockQrRelayClient = MockQrRelayClient(),
        authenticate: @escaping @MainActor @Sendable (String) async throws -> Void = { _ in }
    ) -> CompanionDockViewModel {
        CompanionDockViewModel(
            clients: .shared(client),
            relay: relay,
            servers: [home],
            defaultFqdn: home.fqdn,
            username: "alice",
            authenticate: authenticate,
            confirmGateNanos: 0
        )
    }

    // MARK: - Default mock fixtures

    func test_mockFixture_defaultListIsHonestEmpty() async throws {
        let client = makeClient()
        let r = try await client.companionList()
        XCTAssertTrue(r.companions.isEmpty)
    }

    // MARK: - load()

    func test_load_idle_toLoaded_emptyDefault() async {
        let client = makeClient()
        let vm = makeVM(client)
        await vm.load()
        guard case .loaded(let s) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertTrue(s.companions.isEmpty)
    }

    func test_load_pinnedFixture_isReturnedVerbatim() async {
        let client = makeClient()
        client.companionListFixture = CompanionListResponse(companions: [
            CompanionSummary(
                tokenPrefix: "deadbe",
                redeemedAt: 1_700_000_000_000,
                lastSeenMs: 1_700_000_500_000,
                expiresAt: 1_700_014_400_000,
                userAgent: "Mozilla/5.0"
            ),
            CompanionSummary(
                tokenPrefix: "f00dca",
                redeemedAt: 1_700_000_100_000,
                lastSeenMs: 1_700_000_700_000,
                expiresAt: 1_700_014_500_000,
                userAgent: nil
            )
        ])
        let vm = makeVM(client)
        await vm.load()
        guard case .loaded(let s) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertEqual(s.companions.count, 2)
        XCTAssertEqual(s.companions[0].tokenPrefix, "deadbe")
        XCTAssertEqual(s.companions[0].userAgent, "Mozilla/5.0")
        XCTAssertNil(s.companions[1].userAgent)
    }

    func test_load_failure_surfacesAsFailed() async {
        let client = makeClient()
        client.shouldFail = true
        let vm = makeVM(client)
        await vm.load()
        if case .failed = vm.state {
            // expected
        } else {
            XCTFail("expected .failed, got \(vm.state)")
        }
    }

    // MARK: - remote approval

    private func remoteLink(browserKey: Curve25519.KeyAgreement.PrivateKey = .init()) -> String {
        let sid = Base64URL.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255) }))
        return "flagship://remote?s=\(sid)&k=\(Base64URL.encode(browserKey.publicKey.rawRepresentation))"
    }

    func test_begin_rejectsUnrelatedLink() async {
        let relay = MockQrRelayClient()
        let vm = makeVM(makeClient(), relay: relay)
        await vm.begin(link: "https://example.com/not-remote")
        guard case .failed = vm.phase else { return XCTFail("expected failed, got \(vm.phase)") }
        XCTAssertNil(relay.lastHello)
    }

    func test_begin_rejectsCreateServerRelayLink() {
        let k = Base64URL.encode(Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation)
        let sid = Base64URL.encode(Data(repeating: 1, count: 16))
        XCTAssertFalse(CompanionDockViewModel.isRemoteLink("https://flagshipserver.com/qr?s=\(sid)&k=\(k)"))
        XCTAssertTrue(CompanionDockViewModel.isRemoteLink("flagship://remote?s=\(sid)&k=\(k)"))
    }

    func test_begin_joinsRelayAndShowsMatchCode() async throws {
        let relay = MockQrRelayClient()
        let browser = Curve25519.KeyAgreement.PrivateKey()
        let vm = makeVM(makeClient(), relay: relay)
        await vm.begin(link: remoteLink(browserKey: browser))
        guard case .matching(let code, true) = vm.phase else { return XCTFail("expected matching, got \(vm.phase)") }
        let phonePk = try XCTUnwrap(Base64URL.decode(try XCTUnwrap(relay.lastHello).phonePk))
        let browserSide = try QrRelay.deriveMaterial(phonePrivateKey: browser, browserPublicKey: phonePk)
        XCTAssertEqual(code, browserSide.matchCode)
    }

    func test_approve_mintsOnPickedServer_andSealsTicketToBrowser() async throws {
        let relay = MockQrRelayClient()
        let homeClient = makeClient()
        let labClient = makeClient()
        let browser = Curve25519.KeyAgreement.PrivateKey()
        var reasons: [String] = []
        let vm = CompanionDockViewModel(
            clients: PodScreensClientFactory { fqdn in fqdn == "lab.alice.flagship.services" ? labClient : homeClient },
            relay: relay,
            servers: [home, lab],
            defaultFqdn: home.fqdn,
            username: "alice",
            authenticate: { reasons.append($0) },
            confirmGateNanos: 0
        )
        await vm.begin(link: remoteLink(browserKey: browser))
        await vm.select(fqdn: lab.fqdn)
        await vm.approve()

        XCTAssertEqual(vm.phase, .connected(serverName: "lab"))
        XCTAssertEqual(reasons.count, 1)
        XCTAssertEqual(labClient.companionMintCalls.count, 1)
        XCTAssertTrue(homeClient.companionMintCalls.isEmpty)

        let phonePk = try XCTUnwrap(Base64URL.decode(try XCTUnwrap(relay.lastHello).phonePk))
        let key = try QrRelay.deriveMaterial(phonePrivateKey: browser, browserPublicKey: phonePk).aeadKey
        let deliver = try XCTUnwrap(relay.lastDeliver)
        let ct = try XCTUnwrap(Base64URL.decode(deliver.ciphertext))
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: try XCTUnwrap(Base64URL.decode(deliver.nonce))),
            ciphertext: ct.dropLast(16),
            tag: ct.suffix(16)
        )
        let plain = try AES.GCM.open(box, using: key)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: plain) as? [String: String])
        XCTAssertEqual(obj["kind"], "flagship/remote-ticket/v1")
        XCTAssertEqual(obj["podBaseUrl"], "https://lab.alice.flagship.services")
        XCTAssertEqual(obj["username"], "alice")
        XCTAssertNotNil(obj["ticketId"]?.range(of: "^[0-9a-f]{32}$", options: .regularExpression))
        XCTAssertNotNil(obj["ticketSecret"]?.range(of: "^[0-9a-f]{64}$", options: .regularExpression))
        XCTAssertEqual(Set(obj.keys), ["kind", "ticketId", "ticketSecret", "podBaseUrl", "username"])
    }

    func test_approve_biometricFailureNeverMintsOrDelivers() async {
        struct Cancelled: Error {}
        let relay = MockQrRelayClient()
        let client = makeClient()
        let vm = makeVM(client, relay: relay, authenticate: { _ in throw Cancelled() })
        await vm.begin(link: remoteLink())
        await vm.approve()
        XCTAssertTrue(client.companionMintCalls.isEmpty)
        XCTAssertNil(relay.lastDeliver)
        guard case .failed = vm.phase else { return XCTFail("expected failed, got \(vm.phase)") }
    }

    func test_begin_relayFailureSurfaces() async {
        let relay = MockQrRelayClient()
        relay.behavior = .peerMissing
        let vm = makeVM(makeClient(), relay: relay)
        await vm.begin(link: remoteLink())
        guard case .failed = vm.phase else { return XCTFail("expected failed, got \(vm.phase)") }
    }

    func test_servers_onlineFirst_defaultsToCurrent() {
        let offline = CompanionDockViewModel.ServerChoice(fqdn: "old.alice.flagship.services", name: "old", online: false)
        let vm = CompanionDockViewModel(
            clients: .shared(makeClient()),
            relay: MockQrRelayClient(),
            servers: [offline, home, lab],
            defaultFqdn: lab.fqdn,
            username: "alice"
        )
        XCTAssertEqual(vm.servers.map(\.name), ["home", "lab", "old"])
        XCTAssertEqual(vm.selectedFqdn, lab.fqdn)
    }

    // MARK: - revoke()

    func test_revoke_recordsCall_andClearsPending() async {
        let client = makeClient()
        client.companionListFixture = CompanionListResponse(companions: [
            CompanionSummary(
                tokenPrefix: "deadbe",
                redeemedAt: 1, lastSeenMs: 2, expiresAt: 3, userAgent: nil
            ),
            CompanionSummary(
                tokenPrefix: "f00dca",
                redeemedAt: 1, lastSeenMs: 2, expiresAt: 3, userAgent: nil
            )
        ])
        let vm = makeVM(client)
        await vm.load()
        await vm.revoke(tokenPrefix: "deadbe")
        XCTAssertEqual(client.companionRevokeCalls, ["deadbe"])
        XCTAssertFalse(vm.revokePending.contains("deadbe"))
        guard case .loaded(let s) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertEqual(s.companions.map(\.tokenPrefix), ["f00dca"])
    }

    func test_revoke_failure_surfacesAsFailed_andClearsPending() async {
        let client = makeClient()
        let vm = makeVM(client)
        await vm.load()
        client.shouldFail = true
        await vm.revoke(tokenPrefix: "deadbe")
        if case .failed = vm.state {
            // expected
        } else {
            XCTFail("expected .failed, got \(vm.state)")
        }
        XCTAssertFalse(vm.revokePending.contains("deadbe"))
    }

    // MARK: - Wire-shape codable round-trip

    func test_listResponse_codable_roundTrips() throws {
        let original = CompanionListResponse(companions: [
            CompanionSummary(
                tokenPrefix: "abcdef",
                redeemedAt: 1, lastSeenMs: 2, expiresAt: 3,
                userAgent: "ua"
            ),
            CompanionSummary(
                tokenPrefix: "012345",
                redeemedAt: 4, lastSeenMs: 5, expiresAt: 6,
                userAgent: nil
            )
        ])
        let json = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(CompanionListResponse.self, from: json)
        XCTAssertEqual(decoded, original)
    }

    func test_mintRequest_codable_isEmptyObject() throws {
        let req = CompanionMintTicketRequest()
        let json = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: json) as? [String: Any]
        XCTAssertEqual(obj?.count, 0)
    }

    func test_revokeRequest_codable_carriesTokenPrefix() throws {
        let req = CompanionRevokeRequest(tokenPrefix: "deadbe")
        let json = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: json) as? [String: Any]
        XCTAssertEqual(obj?["tokenPrefix"] as? String, "deadbe")
    }
}

private extension String {
    func repeated(_ count: Int) -> String { String(repeating: self, count: count) }
}
