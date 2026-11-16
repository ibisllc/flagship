import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// The caller's side of a conversation in the app (docs/voici-calls.md "Release-manager decisions" 2): sending, the
/// owner's reply read back, "Show <name> who I am" as a reveal the owner's app checks and pills, Stop call-backs and
/// Delete = forget. The mock `.com` checks signatures for real.
@MainActor
final class VisitorConversationTests: XCTestCase {
    private var calls: JSONValue!
    private let client = MockVoiciComClient()
    private var now: Int64 = 0
    private let umk = [UInt8](repeating: 0x5a, count: 32)
    private let ownSeed = [UInt8](repeating: 0x6b, count: 32)
    private var forgotten: [(conv: String, pseudonymPub: String)] = []

    override func setUp() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../packages/protocol/test-vectors/voici-calls/vectors.json").standardized
        calls = try XCTUnwrap(JSONValue.parse(utf8: Array(try Data(contentsOf: url))))
        now = calls["now"]!.safeInt!
        client.now = { [unowned self] in self.now }
        let ctx = calls["pageV2"]!["ctx"]!
        client.keys["alice"] = VoiciAccountKeys(irkPub: String(repeating: "11", count: 32), adminRootPub: ctx["sensitivePub"]!.string!)
        client.pages["alice"] = calls["pageV2"]!["signed"]!
        // This account's own page "bob", whose key signs the reveal.
        var bob = try XCTUnwrap(VoiciPage.parseVoiciPageIndex(calls["pageV2"]!["signed"]!))
        bob.username = "bob"
        bob.pageId = String(repeating: "b0", count: 16)
        bob.ownerSignPub = CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: ownSeed))
        client.keys["bob"] = client.keys["alice"]
        client.pages["bob"] = try VoiciPage.signVoiciPageIndex(bob, signerSeed: [UInt8](repeating: 0x33, count: 32)).json
        // Delete asks for Face ID / the passcode: passed here unless a test says otherwise.
        GymSeams.bypassBiometricGates = true
        GymSeams.refuseBiometricGates = false
    }

    override func tearDown() async throws {
        GymSeams.bypassBiometricGates = false
        GymSeams.refuseBiometricGates = false
    }

    private func model(defaults: UserDefaults) -> VisitorConversationModel {
        let secret = VoiciMessages.deriveMessagesSecret(umk: umk)
        let deps = VisitorConversationModel.Deps(
            client: client,
            umk: { [umk] in umk },
            session: { [unowned self] pageId, delegatePub, nonce, ttl in
                let p = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: pageId)
                let t = try VoiciMessages.deriveMessagesThreadKey(messagesSecret: secret, pageId: pageId)
                let pPub = CanonicalJson.hex(p.publicKey)
                let att = try MockVoiciComClient.attestation(pseudonymPub: pPub, now: self.now - 1_000)
                let del = WebDelegation(scope: "voici-messages", origin: Endpoints.voiciOrigin, audience: pageId, principalPub: pPub, delegatePub: delegatePub,
                                        issuedAt: self.now - 1_000, expiresAt: self.now + ttl, nonce: nonce)
                let ts = VoiciThreadStatement(pageId: pageId, pseudonymPub: pPub, threadPub: CanonicalJson.hex(t.publicKey), issuedAt: self.now - 1_000)
                let cred = VoiciMessageCred(attestation: att, delegation: del, delegationSig: try WebDelegations.signWebDelegation(del, principalSeed: p.seed),
                                            threadStmt: ts, threadSig: try VoiciMessages.signVoiciThreadStatement(ts, pseudonymSeed: p.seed))
                return VoiciSignInAnswer(pageId: pageId, pseudonymPub: pPub, cred: cred, threadSeed: CanonicalJson.hex(t.seed))
            },
            ownPage: { [ownSeed] in .init(username: "bob", pageId: String(repeating: "b0", count: 16), displayName: "Bob Rivera", signSeed: ownSeed) },
            account: "bob", device: { _, _ in nil }, defaults: defaults, now: { [unowned self] in self.now },
            forgetSynced: { [unowned self] conv, p in self.forgotten.append((conv, p)) })
        return VisitorConversationModel(callee: VoiciCallee(username: "alice", pageId: calls["keys"]!["pageId"]!.string!), displayName: "Alice", deps: deps)
    }

    func test_sendRevealAndTheOwnerChecksIt() async throws {
        let defaults = UserDefaults(suiteName: "visitor-\(UUID())")!
        let m = model(defaults: defaults)
        await m.load()
        XCTAssertEqual(m.phase, .ready)
        XCTAssertTrue(m.hasOwnPage)
        let sent = await m.send("Hello from the app")
        XCTAssertTrue(sent)
        XCTAssertEqual(m.messages.map(\.text), ["Hello from the app"])

        await m.setRevealed(true)
        XCTAssertTrue(m.revealed)
        XCTAssertTrue(defaults.bool(forKey: VisitorConversationModel.revealKey(m.callee.pageId)))
        // The owner's app opens the inbox: two envelopes, one text and one control; the reveal checks under bob's page key.
        let inboxSeed = try CanonicalJson.hexToBytes(calls["keys"]!["inboxSeed"]!.string!)
        let convs = VoiciOwner.conversations(items: client.mailbox["alice"] ?? [], pageId: m.callee.pageId, ownerSignPub: calls["keys"]!["ownerSignPub"]!.string!,
                                             inboxSeed: inboxSeed, caKeys: [MockVoiciComClient.caPub], origin: Endpoints.voiciOrigin)
        let c = try XCTUnwrap(convs.first)
        XCTAssertEqual(c.messages.map(\.text), ["Hello from the app"])
        XCTAssertFalse(c.hasGap, "The control's seq counts.")
        guard case .reveal(let r)? = c.control else { return XCTFail("no reveal") }
        let bobKey = CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: ownSeed))
        let ok = try XCTUnwrap(VoiciConversations.checkReveal(MessagesStore.revealJson(r), conv: c.conv, pageSignPub: bobKey).value)
        XCTAssertEqual(VoiciConversations.pillText(ok), "Bob Rivera (bob)")

        now += 1_000
        await m.setRevealed(false)
        XCTAssertFalse(m.revealed)
        let after = VoiciOwner.conversations(items: client.mailbox["alice"] ?? [], pageId: m.callee.pageId, ownerSignPub: calls["keys"]!["ownerSignPub"]!.string!,
                                             inboxSeed: inboxSeed, caKeys: [MockVoiciComClient.caPub], origin: Endpoints.voiciOrigin)
        guard case .unreveal? = after.first?.control else { return XCTFail("the unreveal is the newest control") }
    }

    func test_deleteForgets() async throws {
        let defaults = UserDefaults(suiteName: "visitor-\(UUID())")!
        let m = model(defaults: defaults)
        await m.load()
        let sent = await m.send("Bye")
        XCTAssertTrue(sent)
        await m.setRevealed(true)
        await m.delete()
        XCTAssertTrue(m.deleted)
        XCTAssertTrue(m.messages.isEmpty)
        XCTAssertEqual(client.convDeletes.first?["del"]?["side"]?.string, "caller")
        XCTAssertTrue((client.mailbox["alice"] ?? []).isEmpty, ".com dropped the conversation's mailbox.")
        XCTAssertFalse(defaults.bool(forKey: VisitorConversationModel.revealKey(m.callee.pageId)))
        // The account's other devices forget it too: the synced state's deletion marker for this conversation.
        XCTAssertEqual(forgotten.map(\.conv), [m.conv])
    }

    /// A cancelled Face ID / passcode prompt deletes nothing and sends nothing (docs/voici-calls.md "Deleting a conversation").
    func test_deleteWithACancelledPromptDeletesNothing() async throws {
        let defaults = UserDefaults(suiteName: "visitor-\(UUID())")!
        let m = model(defaults: defaults)
        await m.load()
        let sent = await m.send("Still here")
        XCTAssertTrue(sent)
        await m.setRevealed(true)
        let mailbox = client.mailbox["alice"]?.count ?? 0
        GymSeams.bypassBiometricGates = false
        GymSeams.refuseBiometricGates = true
        await m.delete()
        XCTAssertFalse(m.deleted)
        XCTAssertEqual(m.messages.map(\.text), ["Still here"])
        XCTAssertTrue(client.convDeletes.isEmpty, "No delete reached .com.")
        XCTAssertEqual(client.mailbox["alice"]?.count ?? 0, mailbox)
        XCTAssertTrue(defaults.bool(forKey: VisitorConversationModel.revealKey(m.callee.pageId)))
        XCTAssertTrue(forgotten.isEmpty, "No deletion marker for the other devices.")
        XCTAssertEqual(m.note, String(localized: "The conversation wasn't deleted."))

        // The same delete with the prompt passed goes through.
        GymSeams.refuseBiometricGates = false
        GymSeams.bypassBiometricGates = true
        await m.delete()
        XCTAssertTrue(m.deleted)
        XCTAssertEqual(client.convDeletes.count, 1)
    }

    func test_anOwnerBlocksAnAnonymousCaller() async throws {
        let k = calls["keys"]!
        let conv = String(repeating: "a0", count: 16)
        let signed = try VoiciConversations.signedAnonBlock(pageId: k["pageId"]!.string!, conv: conv, op: "block", issuedAt: now,
                                                            ownerSignSeed: try CanonicalJson.hexToBytes(k["ownerSignSeed"]!.string!))
        try await client.anonBlock(username: "alice", signed: signed)
        XCTAssertEqual(client.anonBlocks.count, 1)
        let forged = try VoiciConversations.signedAnonBlock(pageId: k["pageId"]!.string!, conv: conv, op: "block", issuedAt: now, ownerSignSeed: Array(repeating: 1, count: 32))
        do {
            try await client.anonBlock(username: "alice", signed: forged)
            XCTFail("a block not signed by the page key")
        } catch {}
        // An anonymous caller's missed call opens, with no pseudonym, and the list names it "Anonymous caller".
        let missed = VoiciMissedCallRow(callId: "c", conv: conv, pseudonymPub: "", reason: "no-answer", ringingAt: 1, video: false)
        let list = VoiciCallHistory.merge(records: [], missed: [missed])
        XCTAssertEqual(list.first?.peer, .visitor(conv: conv, pseudonymPub: ""))
    }
}
