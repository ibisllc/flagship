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
        return m
    }

    private func enroller(_ m: MockSecretMailboxClient, delegatePub: Data? = nil) -> WatchBootKeyEnroller {
        let irk = self.irk, seed = ownerSeed.rawRepresentation, boot = self.boot, now = self.now
        let pub = delegatePub ?? delegate.publicKey.rawRepresentation
        return WatchBootKeyEnroller(mailbox: m, irk: { irk }, unsealSeeds: { _ in [seed] },
                                    delegatePub: { pub }, bootPub: { boot.publicKey.rawRepresentation }, now: { now })
    }

    private func approver(_ m: MockSecretMailboxClient) -> WatchBootApprover {
        let delegate = self.delegate, boot = self.boot, now = self.now
        return WatchBootApprover(mailbox: m, username: username, delegateKey: { delegate }, bootKey: { boot }, now: { now })
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
        let e = WatchBootKeyEnroller(mailbox: m, irk: { self.irk }, unsealSeeds: { _ in [] }, delegatePub: { nil },
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
