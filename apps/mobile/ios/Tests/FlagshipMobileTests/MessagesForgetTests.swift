import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Delete = forget on every device (docs/voici-and-messages.md §10.1.1): the owner's second device, still holding the
/// old Messages state, syncs after the first device deleted a conversation; the conversation is gone on both and
/// stays gone, and the same caller writing again is a new request. Against the mock `.com` (signatures checked).
@MainActor
final class MessagesForgetTests: XCTestCase {
    private var user = ""
    private var mock = MockVoiciComClient()
    private let visitorUmk = [UInt8](repeating: 0x5c, count: 32)
    private func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    override func setUp() {
        super.setUp()
        GymSeams.adminRootSeed = GymSeams.gymAdminRootSeed
        GymSeams.accountRootSeed = Data(repeating: 0x43, count: 32)
        user = "forget-" + String(UUID().uuidString.prefix(8)).lowercased()
        mock = MockVoiciComClient()
        let admin = CanonicalJson.hex(try! CanonicalJson.ed25519PublicKey(seed: Array(GymSeams.gymAdminRootSeed)))
        mock.keys[user] = VoiciAccountKeys(irkPub: String(repeating: "11", count: 32), adminRootPub: admin)
        // Delete asks for Face ID / the passcode: passed here unless a test says otherwise.
        GymSeams.bypassBiometricGates = true
        GymSeams.refuseBiometricGates = false
    }

    override func tearDown() {
        GymSeams.bypassBiometricGates = false
        GymSeams.refuseBiometricGates = false
        GymSeams.adminRootSeed = nil
        GymSeams.accountRootSeed = nil
        MessagesStore.forgetLocal(username: user, allProfiles: false)
        super.tearDown()
    }

    private func store(_ deviceId: String) async -> MessagesStore {
        let s = MessagesStore()
        s.directDelivery = false
        s.configure(client: mock, username: user, deviceId: deviceId, isDemo: false)
        await s.refresh()
        return s
    }

    /// A visitor (another account) writing to the page through the app's caller-side screen.
    private func visitorWrites(_ text: String, pageId: String) async -> VisitorConversationModel {
        let secret = VoiciMessages.deriveMessagesSecret(umk: visitorUmk)
        let deps = VisitorConversationModel.Deps(
            client: mock,
            umk: { [visitorUmk] in visitorUmk },
            session: { [unowned self] pageId, delegatePub, nonce, ttl in
                let p = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: pageId)
                let t = try VoiciMessages.deriveMessagesThreadKey(messagesSecret: secret, pageId: pageId)
                let pPub = CanonicalJson.hex(p.publicKey)
                let at = self.now() - 1_000
                let att = try MockVoiciComClient.attestation(pseudonymPub: pPub, now: at)
                let del = WebDelegation(scope: "voici-messages", origin: Endpoints.voiciOrigin, audience: pageId, principalPub: pPub, delegatePub: delegatePub,
                                        issuedAt: at, expiresAt: at + ttl, nonce: nonce)
                let ts = VoiciThreadStatement(pageId: pageId, pseudonymPub: pPub, threadPub: CanonicalJson.hex(t.publicKey), issuedAt: at)
                let cred = VoiciMessageCred(attestation: att, delegation: del, delegationSig: try WebDelegations.signWebDelegation(del, principalSeed: p.seed),
                                            threadStmt: ts, threadSig: try VoiciMessages.signVoiciThreadStatement(ts, pseudonymSeed: p.seed))
                return VoiciSignInAnswer(pageId: pageId, pseudonymPub: pPub, cred: cred, threadSeed: CanonicalJson.hex(t.seed))
            },
            ownPage: { nil }, account: "visitor", device: { _, _ in nil },
            defaults: UserDefaults(suiteName: "forget-visitor-\(UUID())")!,
            forgetSynced: { _, _ in })
        let m = VisitorConversationModel(callee: VoiciCallee(username: user, pageId: pageId), displayName: "Owner", deps: deps)
        await m.load()
        let sent = await m.send(text)
        XCTAssertTrue(sent)
        return m
    }

    func test_deleteForgetsTheConversationOnTheOwnersOtherDevice() async throws {
        let a = await store("a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0")
        await a.setAcceptsMessages(true)
        await a.goPublic()
        let pageId = try XCTUnwrap(a.index?.pageId)
        _ = await visitorWrites("Hello", pageId: pageId)
        await a.refresh()
        let c = try XCTUnwrap(a.conversations.first)
        await a.accept(c)
        _ = await a.rename(c, to: "Bob")

        let b = await store("b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0")
        XCTAssertTrue(b.conversations.contains { $0.conv == c.conv })
        XCTAssertTrue(b.state.accepted.contains(c.conv))
        XCTAssertEqual(b.state.nicknames[c.pseudonymPub]?.name, "Bob")

        let refused = await a.delete(c)
        XCTAssertNil(refused)
        XCTAssertNotNil(a.state.forgotten[c.conv])
        // B, still on the old state, marks the conversation read: its write conflicts, it merges, and forgets.
        let onB = try XCTUnwrap(b.conversations.first { $0.conv == c.conv })
        await b.markRead(onB)
        await b.refresh()
        await a.refresh()
        for s in [a, b] {
            XCTAssertFalse(s.conversations.contains { $0.conv == c.conv })
            XCTAssertFalse(s.state.accepted.contains(c.conv))
            XCTAssertFalse(s.state.archived.contains(c.conv))
            XCTAssertNil(s.state.readUpTo[c.conv])
            XCTAssertNil(s.state.nicknames[c.pseudonymPub])
        }
        // Stays gone after another round.
        await b.refresh()
        XCTAssertFalse(b.conversations.contains { $0.conv == c.conv })

        // The same caller writing again is a new request, on both devices.
        _ = await visitorWrites("Hello again", pageId: pageId)
        await b.refresh()
        let again = try XCTUnwrap(b.conversations.first { $0.conv == c.conv })
        XCTAssertTrue(b.isRequest(again))
        XCTAssertEqual(again.messages.map(\.text), ["Hello again"])
    }

    /// The owner's delete with a cancelled Face ID / passcode prompt: nothing is deleted on this device or the other,
    /// and no delete reaches `.com` (docs/voici-calls.md "Deleting a conversation").
    func test_ownerDeleteWithACancelledPromptDeletesNothing() async throws {
        let a = await store("c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0")
        await a.setAcceptsMessages(true)
        await a.goPublic()
        let pageId = try XCTUnwrap(a.index?.pageId)
        _ = await visitorWrites("Hello", pageId: pageId)
        await a.refresh()
        let c = try XCTUnwrap(a.conversations.first)
        await a.accept(c)

        GymSeams.bypassBiometricGates = false
        GymSeams.refuseBiometricGates = true
        let refused = await a.delete(c)
        XCTAssertEqual(refused, String(localized: "The conversation wasn't deleted."))
        XCTAssertTrue(mock.convDeletes.isEmpty, "No delete reached .com.")
        XCTAssertTrue(a.conversations.contains { $0.conv == c.conv })
        XCTAssertTrue(a.state.accepted.contains(c.conv))
        XCTAssertNil(a.state.forgotten[c.conv])
        let b = await store("d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0")
        XCTAssertTrue(b.conversations.contains { $0.conv == c.conv })

        // Passed, the same delete goes through.
        GymSeams.refuseBiometricGates = false
        GymSeams.bypassBiometricGates = true
        let done = await a.delete(c)
        XCTAssertNil(done)
        XCTAssertEqual(mock.convDeletes.count, 1)
        XCTAssertFalse(a.conversations.contains { $0.conv == c.conv })
        XCTAssertNotNil(a.state.forgotten[c.conv])
    }
}
