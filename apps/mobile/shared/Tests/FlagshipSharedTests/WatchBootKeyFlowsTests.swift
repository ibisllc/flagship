import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

@MainActor
final class WatchBootKeyFlowsTests: XCTestCase {
    private let domain = "home.bright-maple.flagship.services"
    private let username = "bright-maple"
    private let irk = Curve25519.Signing.PrivateKey()
    private let ownerSeed = Curve25519.Signing.PrivateKey()
    private let stk = Curve25519.Signing.PrivateKey()
    private let delegate = Curve25519.Signing.PrivateKey()
    private let boot = Curve25519.KeyAgreement.PrivateKey()
    private let diskKey = Data((0..<32).map { UInt8($0) })
    private let now: Int64 = 1_800_000_000_000

    private func mailbox() throws -> MockSecretMailboxClient {
        let m = MockSecretMailboxClient()
        let sealed = try SecretSeal.sealForEd25519Recipient(plaintext: diskKey, recipientEd25519Pub: ownerSeed.publicKey.rawRepresentation)
        m.sealedLuksKeyHex = HexUtil.encode(sealed)
        m.directory = [PodDirectoryEntry(serverDomain: domain, identityPubKey: HexUtil.encode(stk.publicKey.rawRepresentation))]
        m.pending = [try signedRequest()]
        return m
    }

    /// The box's request for `requestId`, signed by its STK, as `.com` relays it.
    private func signedRequest(signer: Curve25519.Signing.PrivateKey? = nil, expiresAt: Int64? = nil) throws -> PendingSecretRequest {
        let r = requestId
        let req = SecretRequest(serverDomain: domain, stkPub: stk.publicKey.rawRepresentation, purpose: .unlockKey, nonce: r.nonce, issuedAt: now - 1000)
        let sig = try (signer ?? stk).signature(for: req.canonicalBytes())
        return PendingSecretRequest(serverDomain: domain, requestNonceHex: HexUtil.encode(r.nonce),
                                    stkPub: HexUtil.encode(stk.publicKey.rawRepresentation), purpose: "unlock-key",
                                    issuedAt: now - 1000, requestSignature: HexUtil.encode(sig), deviceInfo: nil,
                                    postedAt: now - 1000, expiresAt: expiresAt ?? now + 600_000)
    }

    private func wire(_ p: PendingSecretRequest, stkPub: String? = nil) -> SignedSecretRequestWire {
        SignedSecretRequestWire(serverDomain: p.serverDomain, requestNonceHex: p.requestNonceHex, stkPub: stkPub ?? p.stkPub,
                                purpose: p.purpose, issuedAt: p.issuedAt, requestSignature: p.requestSignature, expiresAt: p.expiresAt)
    }

    private lazy var pins = ServerKeyPins.volatile()

    /// The phone pinned the server's key at its first blessing (docs/first-contact.md) unless `pinned` is false.
    private func enroller(_ m: MockSecretMailboxClient, delegatePub: Data? = nil, pinned: Bool = true) -> WatchBootKeyEnroller {
        let irk = self.irk, seed = ownerSeed.rawRepresentation, boot = self.boot, now = self.now
        let pub = delegatePub ?? delegate.publicKey.rawRepresentation
        if pinned { pins.pin(stk.publicKey.rawRepresentation, for: domain) }
        return WatchBootKeyEnroller(mailbox: m, username: username, pins: pins, irk: { irk }, unsealSeeds: { _ in [seed] },
                                    delegatePub: { pub }, bootPub: { boot.publicKey.rawRepresentation }, now: { now })
    }

    private func approver(_ m: MockSecretMailboxClient, pinned: Data? = nil) -> WatchBootApprover {
        let delegate = self.delegate, boot = self.boot, now = self.now
        let pin = pinned ?? stk.publicKey.rawRepresentation
        return WatchBootApprover(mailbox: m, username: username, delegateKey: { delegate }, bootKey: { boot },
                                 pinnedStk: { _ in pin }, now: { now })
    }

    private var requestId: (id: String, nonce: Data) {
        let nonce = Data((0..<32).map { UInt8(255 - $0) })
        return ("\(domain)#\(HexUtil.encode(nonce))", nonce)
    }

    func testOnDepositsAnAttestedCopyThatLastsNoLongerThanTheDelegate() async throws {
        let m = try mailbox()
        let ends = try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now + 3 * 86_400_000)
        XCTAssertEqual(ends, now + 3 * 86_400_000)
        let w = try XCTUnwrap(m.watchBootKeys[domain])
        XCTAssertEqual(w.delegatePubHex, HexUtil.encode(delegate.publicKey.rawRepresentation))
        XCTAssertEqual(w.decryptPubHex, HexUtil.encode(boot.publicKey.rawRepresentation))
        let att = WatchBootDelegate(serverDomain: w.serverDomain, delegatePubHex: w.delegatePubHex, decryptPubHex: w.decryptPubHex,
                                    keySha256Hex: w.keySha256Hex, issuedAt: w.issuedAt, expiresAt: w.expiresAt)
        XCTAssertTrue(irk.publicKey.isValidSignature(HexUtil.decode(w.signatureHex)!, for: try att.canonicalBytes()))

        let capped = try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now + 30 * 86_400_000)
        XCTAssertEqual(capped, now + WatchBootDelegate.maxMs, "A copy lasts at most seven days.")
    }

    func testOnWithoutAWatchDelegateDepositsNothing() async throws {
        let m = try mailbox()
        let e = WatchBootKeyEnroller(mailbox: m, username: username, irk: { self.irk }, unsealSeeds: { _ in [] }, delegatePub: { nil },
                                     bootPub: { Data() }, now: { self.now })
        do {
            try await e.turnOn(serverDomain: domain, delegateExpiresAt: now + 1000)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? WatchBootKeyEnroller.Failure, .notEnrolled)
        }
        XCTAssertTrue(m.watchBootKeys.isEmpty)
        do {
            try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now - 1)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? WatchBootKeyEnroller.Failure, .delegateExpired)
        }
    }

    func testTheWatchAnswersWithoutTheAccountKeyAndOnlyTheBoxCanOpenIt() async throws {
        let m = try mailbox()
        try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now + 86_400_000)
        let r = requestId
        let outcome = await approver(m).approve(requestId: r.id)
        XCTAssertEqual(outcome, .approved)
        let posted = try XCTUnwrap(m.postedResponses.last)
        XCTAssertEqual(posted.response.requestNonceHex, HexUtil.encode(r.nonce))
        XCTAssertTrue(posted.bootAuth.hasPrefix("Flagship-Boot-v1 "))
        let opened = try SecretSeal.openWithEd25519Seed(blob: HexUtil.decode(posted.response.sealed)!, recipientEd25519Seed: stk.rawRepresentation)
        XCTAssertEqual(opened.suffix(32), diskKey, "The box's key opens the reply and finds its disk key.")
        XCTAssertThrowsError(try SecretSeal.openWithEd25519Seed(blob: HexUtil.decode(posted.response.sealed)!,
                                                                recipientEd25519Seed: ownerSeed.rawRepresentation))
    }

    func testARequestNamingAnotherBoxKeyIsRefusedAndNothingIsSealedOrPosted() async throws {
        let m = try mailbox()
        try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now + 86_400_000)
        let other = Curve25519.Signing.PrivateKey()
        m.signedRequestsOverride = [wire(try signedRequest(signer: other), stkPub: HexUtil.encode(other.publicKey.rawRepresentation))]
        let outcome = await approver(m).approve(requestId: requestId.id)
        XCTAssertEqual(outcome, .keyMismatch)
        XCTAssertTrue(m.postedResponses.isEmpty)
        XCTAssertTrue(DiagnosticsLog.shared.recent().contains { $0.code == WatchBootApprover.keyMismatchCode && $0.host == domain })
    }

    func testARequestNotSignedByThePinnedKeyIsRefusedAndNothingIsSealedOrPosted() async throws {
        let m = try mailbox()
        try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now + 86_400_000)
        m.signedRequestsOverride = [wire(try signedRequest(signer: Curve25519.Signing.PrivateKey()))]
        let outcome = await approver(m).approve(requestId: requestId.id)
        XCTAssertEqual(outcome, .badSignature)
        XCTAssertTrue(m.postedResponses.isEmpty)
    }

    func testAnExpiredRequestIsRefusedAndNothingIsSealedOrPosted() async throws {
        let m = try mailbox()
        try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now + 86_400_000)
        m.signedRequestsOverride = [wire(try signedRequest(expiresAt: now))]
        let outcome = await approver(m).approve(requestId: requestId.id)
        XCTAssertEqual(outcome, .gone)
        XCTAssertTrue(m.postedResponses.isEmpty)
    }

    func testWithoutAPinnedKeyTheWatchLeavesItToThePhone() async throws {
        let m = try mailbox()
        try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now + 86_400_000)
        let delegate = self.delegate, boot = self.boot, now = self.now
        let a = WatchBootApprover(mailbox: m, username: username, delegateKey: { delegate }, bootKey: { boot },
                                  pinnedStk: { _ in nil }, now: { now })
        let outcome = await a.approve(requestId: requestId.id)
        XCTAssertEqual(outcome, .noCopy)
        XCTAssertTrue(m.postedResponses.isEmpty)
    }

    func testALockedServerIsAnsweredFromThePhoneOnly() async throws {
        let m = try mailbox()
        try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now + 86_400_000)
        m.lockedDomains = [domain]
        let outcome = await approver(m).approve(requestId: requestId.id)
        XCTAssertEqual(outcome, .locked)
        XCTAssertTrue(m.postedResponses.isEmpty)
    }

    func testOffRemovesTheCopyAndTheWatchHasNothingToUse() async throws {
        let m = try mailbox()
        let none = await approver(m).approve(requestId: requestId.id)
        XCTAssertEqual(none, .noCopy)
        try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now + 86_400_000)
        try await enroller(m).turnOff(serverDomain: domain)
        XCTAssertNil(m.watchBootKeys[domain])
        XCTAssertEqual(m.watchBootKeyRevokes, [domain])
        let after = await approver(m).approve(requestId: requestId.id)
        XCTAssertEqual(after, .noCopy)
    }

    func testAnotherWatchsCopyIsNotUsed() async throws {
        let m = try mailbox()
        try await enroller(m, delegatePub: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation)
            .turnOn(serverDomain: domain, delegateExpiresAt: now + 86_400_000)
        let outcome = await approver(m).approve(requestId: requestId.id)
        XCTAssertEqual(outcome, .noCopy)
    }

    func testTurningOnNeedsThePinnedKeyAndRefusesADirectoryNamingAnotherOne() async throws {
        let m = try mailbox()
        do {
            try await enroller(m, pinned: false).turnOn(serverDomain: domain, delegateExpiresAt: now + 86_400_000)
            XCTFail("no pin, nothing to seal to")
        } catch {
            XCTAssertEqual(error as? WatchBootKeyEnroller.Failure, .notPinned)
        }
        XCTAssertNil(pins.pinnedStk(domain), "Turning it on never pins: only the first blessing does.")
        let other = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        m.directory = [PodDirectoryEntry(serverDomain: domain, identityPubKey: HexUtil.encode(other))]
        do {
            try await enroller(m).turnOn(serverDomain: domain, delegateExpiresAt: now + 86_400_000)
            XCTFail("a changed key must be refused")
        } catch {
            XCTAssertEqual(error as? WatchBootKeyEnroller.Failure, .keyChanged)
        }
        XCTAssertNil(m.watchBootKeys[domain], "Nothing deposited for the changed key.")
        XCTAssertEqual(pins.pinnedStk(domain), stk.publicKey.rawRepresentation, "Never replaced silently.")
    }

    func testRequestIdsParse() {
        XCTAssertNil(WatchBootApprover.parse(requestId: "no-hash"))
        XCTAssertNil(WatchBootApprover.parse(requestId: "\(domain)#abcd"))
        XCTAssertEqual(WatchBootApprover.parse(requestId: requestId.id.uppercased())?.serverDomain, domain)
    }

    func testStoreForgetsEndedCopies() {
        let d = UserDefaults(suiteName: "WatchBootKeyFlowsTests-\(UUID().uuidString)")!
        let s = WatchBootKeyStore(defaults: d)
        s.set(now + 10, for: "A.example")
        s.set(now - 10, for: "b.example")
        XCTAssertEqual(s.expiresAt(for: "a.example", now: now), now + 10)
        XCTAssertNil(s.expiresAt(for: "b.example", now: now))
        XCTAssertEqual(s.servers(now: now), ["a.example"])
        s.set(nil, for: "a.example")
        XCTAssertNil(s.expiresAt(for: "a.example", now: now))
    }
}

@MainActor
final class WatchApprovalResponderCopyTests: XCTestCase {
    private struct NoSource: WatchApprovalSource {
        func fetchVerifiedRequests() async throws -> [SecretRequestCoordinator.VerifiedRequest] { [] }
        func confirmAndRespond(_ verified: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Bool) async throws -> String? { nil }
    }

    private func responder(session: Bool, outcome: WatchBootApprover.Outcome) -> WatchApprovalResponder {
        WatchApprovalResponder(delegateEnrolled: { true }, hasSessionKey: { session }, appInForeground: { false },
                               makeSource: { NoSource() }, isPaused: { false }, lockedApprove: { _ in outcome })
    }

    func testTheCopyApprovesWithTheAppLocked() async {
        let r = await responder(session: false, outcome: .approved).respond(to: .init(requestId: "x#y"))
        XCTAssertTrue(r.ok)
    }

    func testAKeyMismatchSaysToUseThePhone() async {
        let r = await responder(session: true, outcome: .keyMismatch).respond(to: .init(requestId: "x#y"))
        XCTAssertEqual(r.errorMessage, WatchApprovalResponder.keyMismatch)
    }

    func testALockedServerSaysSo() async {
        let r = await responder(session: false, outcome: .locked).respond(to: .init(requestId: "x#y"))
        XCTAssertFalse(r.ok)
        XCTAssertEqual(r.errorMessage, WatchApprovalResponder.serverLocked)
    }

    func testNoCopyFallsBackToTheAccountKeyPath() async {
        let locked = await responder(session: false, outcome: .noCopy).respond(to: .init(requestId: "x#y"))
        XCTAssertEqual(locked.errorMessage, WatchApprovalResponder.openAndUnlock)
        let open = await responder(session: true, outcome: .noCopy).respond(to: .init(requestId: "x#y"))
        XCTAssertEqual(open.errorMessage, WatchApprovalResponder.gone, "With the account key open it looks the request up itself.")
    }
}

final class ChatAndConsentWireTests: XCTestCase {
    func testA428CarriesTheEstimate() {
        let body = #"{"error":"consent-required","code":"ai-consent","estimate":{"provider":"openai","source":"byok","operation":"adapt","lowTokens":12000,"highTokens":72000,"unit":"tokens"}}"#
        let c = AiConsentRequired.from(ScreensClientError.http(status: 428, message: body))
        XCTAssertEqual(c?.estimate, AiCostEstimate(provider: "openai", source: "byok", operation: "adapt", lowTokens: 12000, highTokens: 72000))
        XCTAssertEqual(c?.status, 428)
        XCTAssertNil(AiConsentRequired.from(ScreensClientError.http(status: 428, message: #"{"error":"x"}"#)))
        XCTAssertNil(AiConsentRequired.from(ScreensClientError.http(status: 500, message: body)))
    }

    func testTheAdaptRequestCarriesTheConsentOnlyWhenGiven() throws {
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BuildAdaptRequest(background: true))) as? [String: Any]
        XCTAssertNil(plain?["consent"])
        let c = AiConsentBody(issuedAt: 5, provider: "openai", source: "byok", highTokens: 72000, signature: String(repeating: "ab", count: 64))
        let with = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BuildAdaptRequest(background: true, consent: c))) as? [String: Any]
        let sent = with?["consent"] as? [String: Any]
        XCTAssertEqual(sent?["highTokens"] as? Int, 72000)
        XCTAssertEqual(sent?["source"] as? String, "byok")
    }

    func testChatRequestsDecodeTheBoxsShape() throws {
        let json = #"{"requests":[{"requestId":"r1","kind":"incoming","claimedSender":{"author":"ana","slug":"chess"},"receiverApp":{"author":"me","slug":"club"},"phrase":"hi","count":3,"at":7}],"always":[{"receiverApp":{"author":"me","slug":"board"},"claimedSender":{"author":"ana","slug":"chess"}}]}"#
        let r = try JSONDecoder().decode(ChatRequestsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.requests.first?.claimedSender.label, "ana/chess")
        XCTAssertEqual(r.requests.first?.count, 3)
        XCTAssertTrue(r.requests.first?.isIncoming == true)
        XCTAssertEqual(r.always, [ChatAlwaysAllow(receiverApp: ChatAppIdentity(author: "me", slug: "board"),
                                                  claimedSender: ChatAppIdentity(author: "ana", slug: "chess"))])
        let revoke = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            ChatRevokeRequest(receiverApp: ChatAppIdentity(author: "me", slug: "board"), sender: nil))) as? [String: Any]
        XCTAssertEqual(revoke?["slug"] as? String, "board")
        XCTAssertNil(revoke?["sender"], "No sender ends every Always allow to the app.")
        XCTAssertTrue(ChatRequestEvents.isRequestFrame(Data(#"{"type":"chat-request","kind":"incoming"}"#.utf8)))
        XCTAssertFalse(ChatRequestEvents.isRequestFrame(Data(#"{"type":"access-request"}"#.utf8)))
    }
}

@MainActor
final class WatchDelegateRenewerTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000
    private let delegate = Curve25519.Signing.PrivateKey()
    private let irk = Curve25519.Signing.PrivateKey()

    override func setUp() { MockOrderSigners.shared.reset() }

    private func store() -> WatchBootKeyStore {
        WatchBootKeyStore(defaults: UserDefaults(suiteName: "WatchDelegateRenewerTests-\(UUID().uuidString)")!)
    }

    private func renewer(_ s: WatchBootKeyStore, silent: Curve25519.Signing.PrivateKey?, saved: @escaping (String) -> Void = { _ in },
                         redeposited: @escaping (String, Int64) -> Void = { _, _ in }) -> (WatchDelegateRenewer, MockFlagshipServerClient) {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let now = self.now, delegate = self.delegate
        server.nowProvider = { now }
        let r = WatchDelegateRenewer(server: server, username: "bright-maple", store: s, silentKey: { silent },
                                     delegateKey: { delegate }, saveGrantId: saved,
                                     redeposit: { d, e in redeposited(d, e); return e }, now: { now })
        return (r, server)
    }

    func testNotDueWithMoreThanTwoDaysLeft() async {
        let s = store()
        s.delegateExpiresAt = now + 3 * 86_400_000
        let result = await renewer(s, silent: irk).0.renewIfDue()
        XCTAssertEqual(result, .notDue)
    }

    func testDueButNoKeyWithoutAPromptSkips() async {
        let s = store()
        s.delegateExpiresAt = now + 86_400_000
        let result = await renewer(s, silent: nil).0.renewIfDue()
        XCTAssertEqual(result, .skipped)
        XCTAssertEqual(s.delegateExpiresAt, now + 86_400_000)
    }

    func testDueRenewsSilentlyAndPutsEveryCopyBack() async {
        let s = store()
        s.delegateExpiresAt = now + 86_400_000
        s.set(now + 86_400_000, for: "home.example")
        s.set(now - 1, for: "cabin.example")
        var saved: String?
        var redeposited: [String] = []
        let result = await renewer(s, silent: irk, saved: { saved = $0 }, redeposited: { d, _ in redeposited.append(d) }).0.renewIfDue()
        XCTAssertEqual(result, .renewed(expiresAt: now + WatchDelegateRenewer.ttlMs))
        XCTAssertNotNil(saved)
        XCTAssertEqual(s.delegateExpiresAt, now + WatchDelegateRenewer.ttlMs)
        XCTAssertEqual(redeposited, ["cabin.example", "home.example"], "Ended copies come back too.")
        XCTAssertEqual(s.expiresAt(for: "home.example", now: now), now + WatchDelegateRenewer.ttlMs)
    }
}
