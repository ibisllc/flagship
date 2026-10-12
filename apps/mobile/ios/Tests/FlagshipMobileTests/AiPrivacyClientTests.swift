import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipUI
import FlagshipCore

/// docs/ai-privacy-and-staging.md on iOS: the one-step AI adapt (staging, then
/// live), the staged chat Deploy, the owner's signed internet approval for a
/// live app, and the per-key Flagship relay setting.
@MainActor
final class AiPrivacyClientTests: XCTestCase {

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    private func hex(_ s: String) -> Data { HexUtil.decode(s)! }

    // MARK: - Egress grant: canonical bytes + golden vector

    /// 32×0x2a is the UMK; the signer is the protocol IRK derived from it
    /// (`deriveIRK` in packages/protocol/tests/appEgress.test.ts).
    private let umk = Data(repeating: 0x2a, count: 32)
    private let vectorGrant = AppEgressGrant(
        serverDomain: "home.harry.flagship.services",
        serviceId: "harry-weather",
        hosts: ["api.open-meteo.com", "*.tile.openstreetmap.org", "api.github.com"],
        issuedAt: 1_700_000_000_000
    )

    func test_egressCanonicalBytes_matchTheProtocol() {
        XCTAssertEqual(
            String(data: vectorGrant.canonicalBytes(), encoding: .utf8),
            "flagship/app-egress/v1|home.harry.flagship.services|harry-weather|*.tile.openstreetmap.org,api.github.com,api.open-meteo.com|1700000000000"
        )
        let revoke = AppEgressGrant(serverDomain: "home.harry.flagship.services", serviceId: "harry-weather",
                                    hosts: [], issuedAt: 1_700_000_000_000)
        XCTAssertEqual(String(data: revoke.canonicalBytes(), encoding: .utf8),
                       "flagship/app-egress/v1|home.harry.flagship.services|harry-weather||1700000000000")
    }

    func test_egressHosts_areLowercasedDistinctAndSortedByCodeUnit() {
        let g = AppEgressGrant(serverDomain: "d", serviceId: "s",
                               hosts: ["B.example.com", "a.example.com", "b.example.com", " *.x.org "], issuedAt: 1)
        XCTAssertEqual(g.hosts, ["*.x.org", "a.example.com", "b.example.com"])
    }

    func test_egressGoldenVector_bothSignaturesVerify() throws {
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: umk))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation),
                       "c49775473bf9dcf5ad1608c8e66823d55dc6889be27e42a029fd9de195c8d7e4")
        let allow = hex("a3788a82b718af70e81db6b319229d1d469944a999dd7fbe1b77fa1da58c22bcc0d58241d7cbdd9c8954234d03f8d8cdf1e42ef24510eb100a373fdb1ba8f703")
        XCTAssertTrue(key.publicKey.isValidSignature(allow, for: vectorGrant.canonicalBytes()))
        let revoke = AppEgressGrant(serverDomain: vectorGrant.serverDomain, serviceId: vectorGrant.serviceId,
                                    hosts: [], issuedAt: vectorGrant.issuedAt)
        let revokeSig = hex("332195add8c4f75eb5c472500c8b4d253c5024b58fab3dc81b7e84261fabd9f278c5b348991d20e08b7c4799e950b6ece4af2018cd897797de35e8aa3e6e3901")
        XCTAssertTrue(key.publicKey.isValidSignature(revokeSig, for: revoke.canonicalBytes()))
        XCTAssertFalse(key.publicKey.isValidSignature(allow, for: revoke.canonicalBytes()))
        // Our own (randomized) signature verifies against the same bytes.
        let mine = try key.signature(for: vectorGrant.canonicalBytes())
        XCTAssertTrue(key.publicKey.isValidSignature(mine, for: vectorGrant.canonicalBytes()))
    }

    func test_egressRequest_wireShape() throws {
        let body = AppEgressSetRequest(grant: vectorGrant, signature: String(repeating: "ab", count: 64))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        let grant = try XCTUnwrap(obj["grant"] as? [String: Any])
        XCTAssertEqual(grant["serverDomain"] as? String, "home.harry.flagship.services")
        XCTAssertEqual(grant["serviceId"] as? String, "harry-weather")
        XCTAssertEqual(grant["hosts"] as? [String], ["*.tile.openstreetmap.org", "api.github.com", "api.open-meteo.com"])
        XCTAssertEqual((grant["issuedAt"] as? NSNumber)?.int64Value, 1_700_000_000_000)
        XCTAssertEqual((obj["signature"] as? String)?.count, 128)
    }

    // MARK: - Egress card visibility

    func test_egressDecodes_andIsAbsentOnOlderBoxes() throws {
        let base = #""serviceId":"a--b","creator":"a","slug":"b","urlLabel":"b","url":"https://b","status":"running","installedAt":1"#
        let old = try JSONDecoder().decode(AppSummary.self, from: Data("{\(base)}".utf8))
        XCTAssertNil(old.egress)
        XCTAssertNil(ServiceDetailViewModel.egressCard(old.egress, canChange: true))
        let new = try JSONDecoder().decode(AppSummary.self, from: Data(
            "{\(base),\"egress\":{\"declared\":[\"api.x.com\",\"api.y.com\"],\"approved\":[\"api.x.com\"]}}".utf8))
        XCTAssertEqual(new.egress?.pending, ["api.y.com"])
        XCTAssertEqual(new.egress?.hasPending, true)
    }

    func test_egressCard_pendingApprovedNothingAndCompanion() {
        let pending = ServiceDetailViewModel.egressCard(AppEgress(declared: ["a.com", "b.com"], approved: []), canChange: true)
        XCTAssertEqual(pending?.pending, ["a.com", "b.com"])
        XCTAssertEqual(pending?.approved, [])
        XCTAssertEqual(pending?.canChange, true)

        let approved = ServiceDetailViewModel.egressCard(AppEgress(declared: ["a.com"], approved: ["a.com"]), canChange: true)
        XCTAssertEqual(approved?.pending, [])
        XCTAssertEqual(approved?.approved, ["a.com"])

        XCTAssertNil(ServiceDetailViewModel.egressCard(AppEgress(declared: [], approved: []), canChange: true))
        XCTAssertNil(ServiceDetailViewModel.egressCard(nil, canChange: true))

        let companion = ServiceDetailViewModel.egressCard(AppEgress(declared: ["a.com"], approved: []), canChange: false)
        XCTAssertEqual(companion?.pending, ["a.com"])
        XCTAssertEqual(companion?.canChange, false)

        XCTAssertEqual(ServiceDetailViewModel.egressTitle, "This app wants to reach the internet")
        XCTAssertEqual(ServiceDetailViewModel.egressNote,
                       "Until you allow them, the app can't reach any of these. Only allow hosts you expect this app to need.")
    }

    /// The v1 card: a box that sends `egress` but no access lists.
    private func detailVM(_ client: MockScreensClient, key: Curve25519.Signing.PrivateKey,
                          serviceId: String = "bright-maple--plants") -> ServiceDetailViewModel {
        client.mockAccess = [:]
        return ServiceDetailViewModel(
            serviceId: serviceId, client: client, allPods: [], globalLeaderPodId: nil,
            serverDomain: "home.bright-maple.flagship.services",
            egressSigner: { _ in key }
        )
    }

    func test_allowEgress_signsOneHostWithTheSensitiveKey() async throws {
        let client = makeClient()
        let key = Curve25519.Signing.PrivateKey()
        let vm = detailVM(client, key: key)
        await vm.load()
        XCTAssertEqual(vm.egress?.pending, ["api.open-meteo.com"])
        XCTAssertTrue(vm.showsLegacyEgress)
        XCTAssertNil(vm.access)

        let ok = await vm.allowEgress(host: "api.open-meteo.com")
        XCTAssertTrue(ok)
        let call = try XCTUnwrap(client.serviceEgressSetCalls.last)
        XCTAssertEqual(call.serviceId, "bright-maple--plants")
        XCTAssertEqual(call.req.grant.serverDomain, "home.bright-maple.flagship.services")
        XCTAssertEqual(call.req.grant.serviceId, "bright-maple--plants")
        XCTAssertEqual(call.req.grant.hosts, ["api.open-meteo.com"])
        XCTAssertEqual(call.req.signature.count, 128)
        XCTAssertTrue(key.publicKey.isValidSignature(hex(call.req.signature), for: call.req.grant.canonicalBytes()))
        XCTAssertEqual(vm.egress?.approved, ["api.open-meteo.com"])
        XCTAssertEqual(vm.egress?.hasPending, false)
        XCTAssertEqual(vm.egressPhase, .idle)
    }

    func test_stopEgress_signsAnEmptyList() async throws {
        let client = makeClient()
        let key = Curve25519.Signing.PrivateKey()
        let vm = detailVM(client, key: key, serviceId: "bright-maple--wiki")
        await vm.load()
        XCTAssertEqual(vm.egress?.approved, ["api.github.com"])
        let ok = await vm.stopEgress()
        XCTAssertTrue(ok)
        let call = try XCTUnwrap(client.serviceEgressSetCalls.last)
        XCTAssertEqual(call.req.grant.hosts, [])
        XCTAssertTrue(String(data: call.req.grant.canonicalBytes(), encoding: .utf8)!.contains("|bright-maple--wiki||"))
        XCTAssertEqual(vm.egress?.approved, [])
    }

    func test_egressRefusals_arePlain() async {
        let client = makeClient()
        client.serviceEgressSetError = ScreensClientError.http(status: 403, message: #"{"error":"stale grant"}"#)
        let vm = detailVM(client, key: Curve25519.Signing.PrivateKey())
        await vm.load()
        let ok = await vm.allowEgress(host: "api.open-meteo.com")
        XCTAssertFalse(ok)
        guard case .failed(let msg) = vm.egressPhase else { return XCTFail("expected failed") }
        XCTAssertTrue(msg.contains("clock"))
        XCTAssertTrue(ServiceDetailViewModel.egressError(ScreensClientError.http(status: 422, message: #"{"error":"not declared in the app's network.egress: x.com"}"#)).contains("x.com"))
        XCTAssertTrue(ServiceDetailViewModel.egressError(ScreensClientError.http(status: 409, message: "{}")).contains("newer"))
    }

    // MARK: - Relay setting on saved keys

    override func setUp() {
        super.setUp()
        SavedKeyStore().clear()
    }

    override func tearDown() {
        SavedKeyStore().clear()
        super.tearDown()
    }

    func test_oldSavedKeysWithoutRelay_decodeAsRelayOn() throws {
        let json = #"{"entries":[{"id":"k1","provider":"anthropic","label":"Personal","apiKey":"sk-ant-1234567890"}],"activeId":"k1"}"#
        let state = try JSONDecoder().decode(SavedKeyStore.State.self, from: Data(json.utf8))
        XCTAssertEqual(state.entries.first?.relay, true)
        XCTAssertEqual(state.entries.first?.credential.relay, true)
        let off = #"{"id":"k2","provider":"openai","label":"x","apiKey":"sk-x","relay":false}"#
        XCTAssertEqual(try JSONDecoder().decode(SavedKeyStore.Entry.self, from: Data(off.utf8)).relay, false)
    }

    func test_newKeysDefaultToRelay_andTheSettingPersists() throws {
        let store = SavedKeyStore()
        let e = try store.add(provider: "anthropic", label: "P", apiKey: "sk-ant-abcdef123456")
        XCTAssertTrue(e.relay)
        try store.setRelay(id: e.id, relay: false)
        XCTAssertEqual(store.list().first?.relay, false)
        XCTAssertEqual(store.entry(for: LlmProviderCredential(provider: "openai", apiKey: "sk-ant-abcdef123456"))?.id, e.id)
    }

    func test_credentialAlwaysCarriesRelay_onTheWire() throws {
        let on = SavedKeyStore.Entry(id: "a", provider: "anthropic", label: "a", apiKey: "sk-1").credential
        let off = SavedKeyStore.Entry(id: "b", provider: "anthropic", label: "b", apiKey: "sk-2", relay: false).credential
        func wire(_ c: LlmProviderCredential) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(c)) as? [String: Any])
        }
        XCTAssertEqual(try wire(on)["relay"] as? Bool, true)
        XCTAssertEqual(try wire(off)["relay"] as? Bool, false)
        // Chat start/reply and adapt carry it under `credential`.
        let start = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            VibeCodeStartRequest(prompt: "p", model: nil, credential: off))) as? [String: Any])
        XCTAssertEqual((start["credential"] as? [String: Any])?["relay"] as? Bool, false)
        let reply = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            VibeCodeReplyRequest(text: "t", credential: on))) as? [String: Any])
        XCTAssertEqual((reply["credential"] as? [String: Any])?["relay"] as? Bool, true)
        let adapt = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            BuildAdaptRequest(credential: off, background: true))) as? [String: Any])
        XCTAssertEqual((adapt["credential"] as? [String: Any])?["relay"] as? Bool, false)
    }

    func test_openRouterRewrite_keepsRelay() {
        let s = VibeCodeCredentialSelection.compatible(
            with: LlmProviderCredential(provider: "openrouter", apiKey: "sk-or", relay: false))
        XCTAssertEqual(s.credential?.provider, "openai")
        XCTAssertEqual(s.credential?.relay, false)
    }

    func test_addKeyForms_takeTheRelaySwitch() {
        let build = BuildKeyViewModel()
        XCTAssertTrue(build.formRelay)
        build.formApiKey = "sk-ant-abcdef123456"
        build.formRelay = false
        build.saveOnDevice = false
        XCTAssertEqual(build.credentialFromForm()?.relay, false)
        build.resetForm()
        XCTAssertTrue(build.formRelay)
        build.formApiKey = "sk-ant-abcdef654321"
        XCTAssertTrue(build.addFromForm())
        XCTAssertEqual(build.saved.first?.relay, true)
        build.setRelay(build.saved[0], on: false)
        XCTAssertEqual(build.saved.first?.relay, false)
        XCTAssertEqual(build.credential(for: build.saved[0]).relay, false)

        let settings = AiKeysViewModel()
        settings.formApiKey = "sk-openai-abcdef123456"
        settings.formProvider = "openai"
        settings.formRelay = false
        XCTAssertTrue(settings.addFromForm())
        let added = settings.entries.first { $0.provider == "openai" }
        XCTAssertEqual(added?.relay, false)
        settings.setRelay(id: added!.id, on: true)
        XCTAssertEqual(settings.entries.first { $0.provider == "openai" }?.relay, true)

        XCTAssertEqual(AiKeyRelayCopy.toggle, "Send through the Flagship relay")
        XCTAssertEqual(AiKeyRelayCopy.note, "Better for your anonymity: the AI provider sees Flagship's address, not yours.")
        XCTAssertEqual(AiKeyRelayCopy.caption(true), "Through the Flagship relay")
        XCTAssertEqual(AiKeyRelayCopy.caption(false), "Direct")
    }

    func test_relayFailureMessages_areRecognised() {
        XCTAssertTrue(RelayFailure.matches("the Flagship relay isn't reachable, so the AI call wasn't sent"))
        XCTAssertTrue(RelayFailure.matches("the Flagship relay didn't connect to api.anthropic.com because it timed out, so the AI call wasn't sent"))
        XCTAssertTrue(RelayFailure.matches("relay-unavailable"))
        XCTAssertFalse(RelayFailure.matches("docker build failed: exit 1"))
        XCTAssertFalse(RelayFailure.matches(nil))
    }

    func test_adaptRelayFailure_offersToTurnTheRelayOff() async throws {
        let store = SavedKeyStore()
        let e = try store.add(provider: "anthropic", label: "P", apiKey: "sk-ant-relaytest123")
        let client = makeClient()
        client.buildAdaptStatusFixture = BuildAdaptStatus(
            status: "failed", reason: "the Flagship relay isn't reachable, so the AI call wasn't sent")
        let vm = BuildGitViewModel(client: client)
        vm.pollInterval = .milliseconds(1)
        vm.gitUrl = "https://github.com/me/random"
        await vm.checkRepo()
        await vm.adapt(credential: e.credential)
        XCTAssertEqual(vm.errorMessage, "the Flagship relay isn't reachable, so the AI call wasn't sent")
        XCTAssertTrue(vm.relayFailed)
        vm.turnRelayOffForAdaptKey()
        XCTAssertEqual(store.list().first?.relay, false)
        XCTAssertFalse(vm.relayFailed)
    }

    // MARK: - AI adapt: one step, staged

    func test_adaptPhaseText() {
        XCTAssertEqual(BuildGitViewModel.adaptingText(stage: "staging"),
                       "The AI is adapting and testing the app on a private copy with sample data…")
        XCTAssertEqual(BuildGitViewModel.adaptingText(stage: "going-live"), "Installing the tested app…")
        XCTAssertEqual(BuildGitViewModel.adaptingText(stage: nil), "The AI is adapting the repo…")
        XCTAssertEqual(BuildGitScreen.adaptButton, "Use AI to adapt and deploy")
    }

    private func gitVM(_ client: MockScreensClient) async -> BuildGitViewModel {
        let vm = BuildGitViewModel(client: client)
        vm.pollInterval = .milliseconds(1)
        vm.gitUrl = "https://github.com/me/random"
        await vm.checkRepo()
        return vm
    }

    func test_adapt_followsThePhasesAndGoesLive() async {
        let client = makeClient()
        client.buildAdaptStatusScript = [
            BuildAdaptStatus(status: "running", phase: "staging"),
            BuildAdaptStatus(status: "running", phase: "going-live"),
        ]
        client.buildAdaptStatusFixture = BuildAdaptStatus(status: "done", fileCount: 9, deployed: true,
                                                          deployedUrl: "https://random.home.x.flagship.services/")
        let vm = await gitVM(client)
        await vm.adapt(credential: LlmProviderCredential(provider: "anthropic", apiKey: "sk", relay: true))
        XCTAssertEqual(vm.phase, .installed(url: "https://random.home.x.flagship.services/"))
        XCTAssertEqual(client.buildAdaptStartCalls.last?.req.credential?.relay, true)
    }

    func test_adaptDoneButNotLive_showsTheReasonAndOffersAnotherRun() async {
        let client = makeClient()
        client.buildAdaptStatusFixture = BuildAdaptStatus(status: "done", fileCount: 9, deployed: false,
                                                          reason: "the app never answered on its port")
        let vm = await gitVM(client)
        await vm.adapt()
        guard case .verdict(let v) = vm.phase else { return XCTFail("expected the not-ready card, got \(vm.phase)") }
        XCTAssertFalse(v.fit)
        XCTAssertEqual(vm.errorMessage, "The app didn't go live: the app never answered on its port")
        XCTAssertFalse(vm.sealed)
    }

    func test_adaptOnASealedBuild_offersCheckAgainInstead() async {
        let client = makeClient()
        client.buildSealedFixture = true
        client.buildAdaptStatusFixture = BuildAdaptStatus(status: "done", fileCount: 9, deployed: false,
                                                          reason: "docker run failed")
        let vm = await gitVM(client)
        await vm.adapt()
        XCTAssertTrue(vm.sealed)
        // No second AI run on this build.
        let calls = client.buildAdaptStartCalls.count
        await vm.adapt()
        XCTAssertEqual(client.buildAdaptStartCalls.count, calls)
        // "Check again" starts a new build, open to the AI again.
        client.buildSealedFixture = nil
        await vm.checkRepo()
        XCTAssertFalse(vm.sealed)
    }

    func test_adaptRefusedAsClosedToTheAI_isSealed() async {
        let client = makeClient()
        let vm = await gitVM(client)
        client.buildAdaptStartError = ScreensClientError.http(
            status: 409,
            message: #"{"error":"This build is closed to the AI: it was handed to the box to go live. Start a new build to change the app."}"#)
        await vm.adapt()
        XCTAssertTrue(vm.sealed)
        guard case .verdict = vm.phase else { return XCTFail("expected the not-ready card, got \(vm.phase)") }
        XCTAssertTrue(vm.errorMessage?.hasPrefix("This build is closed to the AI") == true)
    }

    // MARK: - Chat Deploy: staged in the background

    func test_chatDeployPhaseText() {
        XCTAssertEqual(VibeCodeDeployRun.phaseText("staging"), "Testing the app on a private copy…")
        XCTAssertEqual(VibeCodeDeployRun.phaseText("fixing"), "The AI is fixing a problem it found…")
        XCTAssertEqual(VibeCodeDeployRun.phaseText("going-live"), "Installing…")
        XCTAssertEqual(VibeCodeDeployRun.phaseText(nil), "Building and starting your app…")
    }

    func test_chatDeploy_backgroundIsFollowedThroughItsPhases() async throws {
        let client = makeClient()
        var phases: [String?] = []
        let outcome = try await VibeCodeDeployRun.run(client: client, sessionId: "vc-1",
                                                      pollInterval: .milliseconds(1)) { phases.append($0) }
        XCTAssertEqual(client.vibeCodeDeployStartCalls, ["vc-1"])
        XCTAssertEqual(phases, ["staging", "fixing", "going-live"])
        XCTAssertEqual(outcome, .deployed(url: "https://habits.home.bright-maple.flagship.services/", inviteOnly: nil))
    }

    func test_chatDeploy_olderBoxAnswersWithTheFinishedResult() async throws {
        let client = makeClient()
        client.vibeCodeDeployStartFixture = VibeCodeDeployReply(
            ok: true, serviceId: "a--b", url: "https://b.home.x.flagship.services/", inviteOnly: false)
        let outcome = try await VibeCodeDeployRun.run(client: client, sessionId: "vc-2", pollInterval: .milliseconds(1))
        XCTAssertEqual(outcome, .deployed(url: "https://b.home.x.flagship.services/", inviteOnly: false))
        XCTAssertEqual(client.vibeCodeStatusCalls, 0)
    }

    func test_chatDeploy_failureCarriesTheBoxReason() async throws {
        let client = makeClient()
        client.vibeCodeDeployStartFixture = VibeCodeDeployReply(ok: true, started: true)
        client.vibeCodeStatusScript = [
            VibeCodeStatusResponse(status: "deploying", transcript: [], files: [:], deployedUrl: nil, errorReason: nil,
                                   deployPhase: "staging"),
            VibeCodeStatusResponse(status: "failed", transcript: [], files: [:], deployedUrl: nil,
                                   errorReason: "the app never started"),
        ]
        let outcome = try await VibeCodeDeployRun.run(client: client, sessionId: "vc-3", pollInterval: .milliseconds(1))
        XCTAssertEqual(outcome, .failed("the app never started"))
    }

    func test_chatDeploy_alreadyDeployingIsFollowed() async throws {
        let client = makeClient()
        client.vibeCodeDeployStartError = ScreensClientError.http(status: 409, message: #"{"error":"already deploying"}"#)
        client.vibeCodeStatusScript = [
            VibeCodeStatusResponse(status: "deployed", transcript: [], files: [:],
                                   deployedUrl: "https://c.home.x.flagship.services/", errorReason: nil),
        ]
        let outcome = try await VibeCodeDeployRun.run(client: client, sessionId: "vc-4", pollInterval: .milliseconds(1))
        XCTAssertEqual(outcome, .deployed(url: "https://c.home.x.flagship.services/", inviteOnly: nil))
    }

    func test_chatDeployReply_andPhaseFieldsDecode() throws {
        let started = try JSONDecoder().decode(VibeCodeDeployReply.self, from: Data(#"{"ok":true,"started":true}"#.utf8))
        XCTAssertEqual(started.started, true)
        let finished = try JSONDecoder().decode(VibeCodeDeployReply.self, from: Data(
            #"{"ok":true,"serviceId":"a--b","url":"https://b/","inviteOnly":true}"#.utf8))
        XCTAssertNil(finished.started)
        XCTAssertEqual(finished.url, "https://b/")
        let status = try JSONDecoder().decode(VibeCodeStatusResponse.self, from: Data(
            #"{"status":"deploying","deployPhase":"fixing","transcript":[],"files":{}}"#.utf8))
        XCTAssertEqual(status.deployPhase, "fixing")
        let state = try JSONDecoder().decode(BuildStateResponse.self, from: Data(
            #"{"state":{"buildId":"b","mode":"git","sealed":true,"adapt":{"status":"running","startedAt":1,"phase":"going-live"}},"files":[]}"#.utf8))
        XCTAssertEqual(state.state.sealed, true)
        XCTAssertEqual(state.state.adapt?.phase, "going-live")
    }
}
