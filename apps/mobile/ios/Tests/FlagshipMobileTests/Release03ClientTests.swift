import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore
@testable import Flagship

/// SEC-REPAIR-001 (recovery passkey, the once-only update), wipe & restart's new attestation,
/// SEC-BROWSER-002 (browser grants) and N12 (upstream sync), against the mock `.com` and box.
@MainActor
final class Release03ClientTests: XCTestCase {
    private let username = "demo1234"
    private let passphrase = "correct horse battery staple"

    override func setUp() async throws {
        try await super.setUp()
        Keystore.wipe()
        RecoveryUpdatePrompt.store = UserDefaults(suiteName: "release03-\(UUID().uuidString)")!
        MockOrderSigners.shared.reset()
    }

    override func tearDown() async throws {
        Keystore.wipe()
        RecoveryUpdatePrompt.forget(username)
        try await super.tearDown()
    }

    private func server() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    // MARK: - Recovery passkey

    func test_setupSendsTheAttestationAndRecoverySignsComsChallengeInTheSameSheet() async throws {
        try await Keystore.generateUMK(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "t")
        let s = server()
        let webAuthn = MockWebAuthnProvider()
        let setup = RecoveryViewModel(client: s, webAuthn: webAuthn, username: { [username] in username })
        await setup.setup(umkSeed: umk, passphrase: passphrase)
        guard case .registered = setup.phase else { return XCTFail("setup: \(setup.phase)") }
        XCTAssertTrue(s.recoveryRecordHoldsPasskey(username: username), "The attestation went beside the record.")
        let state = try await s.recoveryRecordState(username: username)
        XCTAssertEqual(state?.passkeyRequired, true)

        let recover = RecoveryViewModel(client: s, webAuthn: webAuthn)
        let seed = await recover.recover(username: username, passphrase: passphrase)
        XCTAssertNotNil(seed, "recover: \(recover.phase)")
        XCTAssertEqual(seed?.withUnsafeBytes { Data($0) }, umk.withUnsafeBytes { Data($0) })
        let issued = try XCTUnwrap(s.recoveryChallengesIssued.last)
        XCTAssertEqual(webAuthn.signedChallenges.last, RecoveryPasskey.challengeBytes(issued),
                       "The one passkey sheet signed the challenge .com issued.")
        XCTAssertEqual(s.recoveryFetchPasskeys.last??.challenge, issued, "The fetch carried that signature.")
        XCTAssertFalse(recover.recoveredRecordNeedsPasskeyUpdate)
    }

    func test_aPasskeyRefusalIsSaidInItsOwnWords() async throws {
        try await Keystore.generateUMK(reason: "test")
        let s = server()
        let setup = RecoveryViewModel(client: s, webAuthn: MockWebAuthnProvider(), username: { [username] in username })
        await setup.setup(umkSeed: try await Keystore.currentUMK(reason: "t"), passphrase: passphrase)
        s.recoveryPasskeyRefusalCode = "passkey-invalid"
        let recover = RecoveryViewModel(client: s, webAuthn: MockWebAuthnProvider())
        let seed = await recover.recover(username: username, passphrase: passphrase)
        XCTAssertNil(seed)
        XCTAssertEqual(recover.phase.failureMessage, "That passkey isn't the one your account recovery uses.")
    }

    func test_aRecordFromBeforeStillRecoversAndAsksForTheUpdate() async throws {
        let s = server()
        let secrets = try RecoveryDerivation.derivePassphraseSecrets(passphrase, username)
        let webAuthn = MockWebAuthnProvider()
        let prf = try await webAuthn.prfAssert(credentialId: "aabbccdd00112233", prfSalt: secrets.prfSalt)
        let umk = SymmetricKey(size: .bits256)
        s.seedRecoveryRecord(username: username, credentialId: "aabbccdd00112233",
                             wrappedUmk: try Recovery.wrap(umkSeed: umk, prfSecret: prf),
                             fetchTokenHash: RecoveryDerivation.sha256Hex(secrets.fetchToken),
                             prfSaltHash: RecoveryDerivation.sha256Hex(secrets.prfSalt), passkey: false)
        // A `.com` without the passkey check at all: the passphrase alone releases a record from before.
        s.recoveryChallengeUnavailable = true
        let recover = RecoveryViewModel(client: s, webAuthn: webAuthn)
        let seed = await recover.recover(username: username, passphrase: passphrase)
        XCTAssertNotNil(seed, "recover: \(recover.phase)")
        XCTAssertEqual(s.recoveryFetchPasskeys.last.map { $0 == nil }, true, "No challenge, no passkey field.")
        XCTAssertTrue(recover.recoveredRecordNeedsPasskeyUpdate)
    }

    func test_aKeyedRecordIsNotFetchedWithoutTheCheck() async throws {
        let s = server()
        s.seedRecoveryRecord(username: username, credentialId: "aabbccdd00112233", wrappedUmk: "AA==",
                             fetchTokenHash: String(repeating: "0", count: 64), prfSaltHash: String(repeating: "0", count: 64),
                             passkey: true)
        s.recoveryChallengeUnavailable = true
        let recover = RecoveryViewModel(client: s, webAuthn: MockWebAuthnProvider())
        let seed = await recover.recover(username: username, passphrase: passphrase)
        XCTAssertNil(seed)
        XCTAssertTrue(s.recoveryFetchPasskeys.isEmpty, "Nothing is fetched when the passkey can't be checked.")
    }

    func test_theUpdateIsAskedOnceAndUsesTheHeldPassphrase() async throws {
        let legacy = RecoveryRecordState(credentialId: "aa", wrappedUmkHash: "", legacy: false, passkeyRequired: false)
        XCTAssertTrue(RecoveryUpdatePrompt.shouldAsk(state: legacy, username: username))
        XCTAssertFalse(RecoveryUpdatePrompt.shouldAsk(state: nil, username: username))
        XCTAssertFalse(RecoveryUpdatePrompt.shouldAsk(
            state: RecoveryRecordState(credentialId: "aa", wrappedUmkHash: "", legacy: false, passkeyRequired: true), username: username))

        try await Keystore.generateUMK(reason: "test")
        let s = server()
        s.seedRecoveryRecord(username: username, credentialId: "aabbccdd00112233", wrappedUmk: "AA==",
                             fetchTokenHash: String(repeating: "0", count: 64), prfSaltHash: String(repeating: "0", count: 64),
                             passkey: false)
        RecoveryUpdatePrompt.hold(passphrase: passphrase, for: username)
        let vm = RecoveryUpdateViewModel(username: username, client: s, webAuthn: MockWebAuthnProvider())
        XCTAssertTrue(vm.holdsPassphrase, "Right after a recovery the passphrase isn't asked again.")
        XCTAssertNil(vm.fieldError)
        let ok = await vm.update()
        XCTAssertTrue(ok, "update: \(vm.phase)")
        XCTAssertTrue(s.recoveryRecordHoldsPasskey(username: username))
        XCTAssertNil(RecoveryUpdatePrompt.heldPassphrase(for: username), "Forgotten once used.")
        XCTAssertFalse(RecoveryUpdatePrompt.shouldAsk(state: legacy, username: username), "Asked once.")
    }

    func test_declineMarksAskedAndTypedPassphrasesAreChecked() {
        let vm = RecoveryUpdateViewModel(username: username, client: server(), webAuthn: MockWebAuthnProvider())
        XCTAssertFalse(vm.holdsPassphrase)
        vm.passphrase = "short"
        XCTAssertEqual(vm.fieldError, "Use at least 8 characters.")
        vm.passphrase = "a whole sentence"
        vm.passphrase2 = "a whole sentenc"
        XCTAssertEqual(vm.fieldError, "Passphrases do not match.")
        vm.decline()
        XCTAssertTrue(RecoveryUpdatePrompt.wasAsked(username: username))
    }

    // MARK: - Wipe & restart

    func test_wipeRestartSendsTheNewPasskeysAttestation() async throws {
        try await Keystore.generateUMK(reason: "test")
        let s = server()
        s.wipeRestartBehavior = .ok
        let vm = WipeRestartViewModel(server: s, webAuthn: MockWebAuthnProvider(), username: { "alice" })
        await vm.run(currentEtag: nil)
        XCTAssertEqual(vm.phase, .completed)
        let last = try XCTUnwrap(s.lastWipeRestart)
        XCTAssertEqual(last.body.newPasskeyAttestationObject, RecoveryPasskey.attestationField(Data("mock-attestation".utf8)))
    }

    // MARK: - Browser grants

    func test_browserGrantWords() {
        XCTAssertEqual(BrowserGrantCopy.allow("once"), "Allow once")
        XCTAssertEqual(BrowserGrantCopy.allow("session"), "Allow for this session")
        XCTAssertEqual(BrowserGrantCopy.allow("service"), "Always allow")
        XCTAssertEqual(BrowserGrantCopy.duration("once"), "For one visit")
        XCTAssertEqual(BrowserGrantCopy.duration("session"), "Until this browser session ends")
        XCTAssertEqual(BrowserGrantCopy.duration("service"), "Until you remove it")
        XCTAssertEqual(["navigate", "read-dom", "screenshot", "input", "download"].map(BrowserGrantCopy.capability),
                       ["Open pages", "Read page content", "Take screenshots", "Type and click", "Download files"])
        XCTAssertEqual(BrowserGrantCopy.originNote("*.example.org"), "and every address under it")
        XCTAssertNil(BrowserGrantCopy.originNote("news.example.com"))
        XCTAssertEqual(BrowserGrantCopy.localNetwork(.wholeLan), "Every device on your local network")
        XCTAssertEqual(BrowserGrantCopy.localNetwork(.exact(["192.168.1.20", "nas.local"])),
                       "These devices on your network: 192.168.1.20, nas.local")
        XCTAssertNil(BrowserGrantCopy.localNetwork(nil))
        XCTAssertEqual(BrowserGrantCopy.ask(app: "plants"), "plants wants to use this server's browser.")
        XCTAssertEqual(BrowserGrantCopy.message(for: ScreensClientError.http(status: 403, message: "")),
                       "This device can't approve browser access. Use an admin device.")
        XCTAssertEqual(BrowserGrantCopy.message(for: ScreensClientError.http(status: 404, message: "")),
                       "That request is no longer waiting.")
    }

    func test_allowSignsTheAskAndDenySendsNoSignature() async throws {
        let screens = MockScreensClient()
        let ask = BrowserGrantRequest(requestId: "11111111-1111-4111-8111-111111111111", serviceId: "bright-maple--plants",
                                      capabilities: ["read-dom", "navigate"], origins: ["news.example.com"], duration: "once")
        let other = BrowserGrantRequest(requestId: "22222222-2222-4222-8222-222222222222", serviceId: "bright-maple--plants",
                                        capabilities: ["navigate"], origins: ["x.example"], duration: "service")
        screens.mockBrowserGrantRequests = [ask, other]
        let key = Curve25519.Signing.PrivateKey()
        let domain = await screens.boxDomain() ?? "home.bright-maple.flagship.services"
        try await BrowserGrantAnswerOrder.send(ask, allow: true, appName: "plants", client: screens,
                                               fallbackServerDomain: domain, signer: { _ in key })
        let allowed = try XCTUnwrap(screens.browserGrantAnswers.first)
        XCTAssertEqual(allowed.decision, "allow")
        let bytes = try BrowserGrantOrder.answer(for: ask, serverDomain: domain, decision: "allow", issuedAt: allowed.issuedAt).canonicalBytes()
        XCTAssertTrue(key.publicKey.isValidSignature(HexUtil.decode(allowed.signature ?? "") ?? Data(), for: bytes))

        var signed = false
        try await BrowserGrantAnswerOrder.send(other, allow: false, appName: "plants", client: screens,
                                               fallbackServerDomain: domain, signer: { _ in signed = true; return key })
        XCTAssertFalse(signed, "A denial only narrows: no Face ID, no signature.")
        XCTAssertNil(screens.browserGrantAnswers.last?.signature)
        XCTAssertTrue(screens.mockBrowserGrantRequests.isEmpty)
    }

    func test_allowOnceOnASessionAskSignsOnceAndTheMockRefusesWider() async throws {
        let screens = MockScreensClient()
        let ask = BrowserGrantRequest(requestId: "44444444-4444-4444-8444-444444444444", serviceId: "bright-maple--wiki",
                                      capabilities: ["navigate"], origins: ["w.example"], duration: "session")
        screens.mockBrowserGrantRequests = [ask]
        let key = Curve25519.Signing.PrivateKey()
        let domain = await screens.boxDomain() ?? "home.bright-maple.flagship.services"
        // Wider than asked is never signed.
        var asked = false
        do {
            try await BrowserGrantAnswerOrder.send(ask, allow: true, duration: "service", appName: "wiki", client: screens,
                                                   fallbackServerDomain: domain, signer: { _ in asked = true; return key })
            XCTFail("a wider answer is refused")
        } catch {}
        XCTAssertFalse(asked, "No Face ID for an answer that would be refused.")
        try await BrowserGrantAnswerOrder.send(ask, allow: true, duration: "once", appName: "wiki", client: screens,
                                               fallbackServerDomain: domain, signer: { _ in key })
        let a = try XCTUnwrap(screens.browserGrantAnswers.last)
        XCTAssertEqual(a.duration, "once")
        let bytes = try BrowserGrantOrder.answer(for: ask, serverDomain: domain, decision: "allow", duration: "once", issuedAt: a.issuedAt).canonicalBytes()
        XCTAssertTrue(String(decoding: bytes, as: UTF8.self).contains("|allow|once|"))
        XCTAssertTrue(key.publicKey.isValidSignature(HexUtil.decode(a.signature ?? "") ?? Data(), for: bytes))
        XCTAssertEqual(screens.mockBrowserGrants.map(\.duration), ["once"])
    }

    func test_theAppPageListsGrantsAndWithdrawSignsTheRevoke() async throws {
        let screens = MockScreensClient()
        let g = OwnerBrowserGrant(grantId: "bg-1", serviceId: "bright-maple--plants", capabilities: ["navigate"],
                                  origins: ["shop.example.com"], duration: "service", explanation: "prices")
        screens.mockBrowserGrants = [g, OwnerBrowserGrant(grantId: "bg-2", serviceId: "bright-maple--wiki", capabilities: ["navigate"],
                                                          origins: ["w.example"], duration: "service")]
        let key = Curve25519.Signing.PrivateKey()
        var reasons: [String] = []
        let ctl = BrowserGrantsController(serviceId: "bright-maple--plants", appName: "plants",
                                          serverDomain: "home.bright-maple.flagship.services", client: screens,
                                          signer: { r in reasons.append(r); return key })
        await ctl.load()
        XCTAssertEqual(ctl.grants.map(\.grantId), ["bg-1"], "Only this app's grants.")
        await ctl.withdraw(g)
        XCTAssertEqual(reasons, ["Withdraw plants's browser access"])
        XCTAssertEqual(ctl.note, "Browser access withdrawn")
        XCTAssertTrue(ctl.grants.isEmpty)
        let rv = try XCTUnwrap(screens.browserGrantRevokes.last)
        let domain = await screens.boxDomain() ?? "home.bright-maple.flagship.services"
        let bytes = try BrowserGrantRevoke(serverDomain: domain, serviceId: rv.serviceId, grantId: rv.grantId, issuedAt: rv.issuedAt).canonicalBytes()
        XCTAssertTrue(key.publicKey.isValidSignature(HexUtil.decode(rv.signature) ?? Data(), for: bytes))
        // Already gone: said in its own words.
        await ctl.withdraw(g)
        XCTAssertEqual(ctl.error, "That access was already withdrawn.")
    }

    func test_centerAsksEveryBoxAndNamesTheVerifiedApp() async throws {
        let screens = MockScreensClient()
        screens.mockBrowserGrantRequests = [BrowserGrantRequest(requestId: "11111111-1111-4111-8111-111111111111",
                                                                serviceId: "bright-maple--plants", capabilities: ["navigate"],
                                                                origins: ["a.example"], duration: "session")]
        let key = Curve25519.Signing.PrivateKey()
        let center = BrowserGrantCenter(boxes: { [AppAccessAlertCenter.Box(serverDomain: "home.bright-maple.flagship.services", client: screens)] },
                                        signer: { _ in key })
        await center.refresh()
        XCTAssertEqual(center.current?.appName, "plants")
        await center.allow()
        XCTAssertEqual(center.stage, .done(allow: true))
        center.close()
        XCTAssertNil(center.current)
    }

    // MARK: - Upstream sync

    func test_syncWordsAndSections() {
        XCTAssertEqual(UpstreamSyncCopy.check("github.com/ana/plants"), "Check for updates from github.com/ana/plants")
        XCTAssertEqual(UpstreamSyncCopy.version("abcdef0123456789abcdef"), "Version abcdef012345")
        XCTAssertEqual(["network.egress", "network.subdomain", "data.stores", "browser.domains", "access", "runtime", "distribution", "other"]
                        .map(UpstreamSyncCopy.section),
                       ["Internet access", "Web addresses", "Data stores", "Browser sites", "Public pages", "Runtime", "Distribution", "other"])
        XCTAssertEqual(UpstreamSyncCopy.message(for: ScreensClientError.http(status: 404, message: "{}")),
                       "This app wasn't imported from a repo on this server, so it can't check for updates.")
    }

    func test_syncShowsTheProposalAndUpToDateOpensNoBuild() async throws {
        let screens = MockScreensClient()
        let proposal = AppSyncResponse(buildId: "b1", proposal: SyncProposal(takeUpstream: ["a"], conflicts: ["b"],
                                                                             capabilityChanges: [.init(section: "network.egress", added: ["x"], removed: [])],
                                                                             clean: false),
                                       candidateCommit: "abc", upToDate: false)
        screens.mockSyncResponses["s1"] = proposal
        let vm = UpstreamSyncViewModel(serviceId: "s1", repo: "r", client: screens)
        vm.ref = " v2 "
        await vm.check()
        XCTAssertEqual(vm.phase, .proposal(proposal))
        XCTAssertEqual(screens.appSyncCalls.last?.ref, "v2")

        // Up to date: the box opens no build, so closing discards nothing.
        screens.mockSyncResponses["s2"] = AppSyncResponse(buildId: nil, proposal: nil, candidateCommit: "c", upToDate: true)
        let current = UpstreamSyncViewModel(serviceId: "s2", repo: "r", client: screens)
        await current.check()
        XCTAssertEqual(current.phase, .upToDate)
        XCTAssertNil(current.openBuildId)
        XCTAssertNil(screens.appSyncCalls.last?.ref, "A blank ref sends none.")
        let discardsBefore = screens.buildDiscardCalls.count
        await current.discard()
        XCTAssertEqual(screens.buildDiscardCalls.count, discardsBefore, "Nothing to discard.")

        // A proposal's build is still discarded when the owner closes it.
        await vm.discard()
        XCTAssertEqual(screens.buildDiscardCalls.last, "b1")

        let missing = UpstreamSyncViewModel(serviceId: "nope", repo: "r", client: screens)
        await missing.check()
        XCTAssertEqual(missing.phase, .failed(UpstreamSyncCopy.notImported))
    }
}

private extension RecoveryViewModel.Phase {
    var failureMessage: String? { if case .failed(let m) = self { return m }; return nil }
}
