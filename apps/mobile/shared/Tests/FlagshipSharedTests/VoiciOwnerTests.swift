import XCTest
import CryptoKit
@testable import FlagshipCore

/// The owner's side of voi.ci pages and Messages end to end against the mock `.com` (docs/voici-and-messages.md):
/// publish a page, receive a visitor's message, reply, and the checks that drop what must not show.
final class VoiciOwnerTests: XCTestCase {
    let umk = [UInt8](repeating: 0x47, count: 32)
    let admin = [UInt8](repeating: 0x21, count: 32)
    let pageId = String(repeating: "a1", count: 16)
    let now: Int64 = 1_800_000_000_000

    private func mock() throws -> MockVoiciComClient {
        let m = MockVoiciComClient()
        m.now = { [now] in now }
        m.keys["ana"] = VoiciAccountKeys(irkPub: String(repeating: "11", count: 32), adminRootPub: CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: admin)))
        return m
    }

    private func state(_ posts: [VoiciPost] = []) -> VoiciPageState {
        VoiciPageState(profile: VoiciProfile(displayName: "Ana", bio: "Hello", avatar: nil, theme: "classic", links: []),
                       acceptsMessages: 1, chunks: VoiciPage.chunkVoiciPosts(posts), issuedAt: 0)
    }

    private func publish(_ m: MockVoiciComClient, _ s: VoiciPageState, seq: Int64) async throws -> VoiciPageIndex {
        let inbox = try VoiciMessages.deriveVoiciInboxKey(umk: umk, pageId: pageId, inboxEpoch: 1)
        let sign = try VoiciMessages.deriveVoiciOwnerSignKey(umk: umk, pageId: pageId, inboxEpoch: 1)
        let pieces = try XCTUnwrap(try VoiciOwner.pieces(s, images: [:]))
        for p in pieces {
            let up = VoiciPieceUpload(username: "ana", pageId: pageId, sha256: p.ref.sha256, size: p.ref.size, issuedAt: now)
            try await m.uploadPiece(username: "ana", upload: up, signerPub: CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: admin)),
                                    signature: try VoiciPage.signVoiciPieceUpload(up, signerSeed: admin), bytes: p.bytes)
        }
        let idx = try VoiciPage.signVoiciPageIndex(VoiciPageIndex(
            username: "ana", pageId: pageId, seq: seq, issuedAt: now, acceptsMessages: s.acceptsMessages, inboxEpoch: 1,
            inboxPub: CanonicalJson.hex(inbox.publicKey), ownerSignPub: CanonicalJson.hex(sign.publicKey), pieces: pieces.map(\.ref),
            signerKind: "admin-root"), signerSeed: admin)
        try await m.publish(username: "ana", index: idx.json)
        return idx
    }

    /// Capped server copy (§2.7a): the oldest chunks are phone-only; the phone serves them, another device carries them.
    func testPhoneOnlyChunksAreServedByThePhoneAndCarriedByADeviceWithoutThem() async throws {
        let card: [UInt8] = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 9, 0xff, 0xd9]
        let cardSha = CanonicalJson.sha256Hex(card)
        let chunks: [[VoiciPost]] = (0..<12).map { i in
            let links = i == 0 ? [VoiciPostLink(url: "https://example.com/old", card: VoiciCard(title: "Old", site: "example.com", description: "", image: cardSha))] : []
            return [VoiciPost(id: String(format: "%032x", i + 1), createdAt: now - 100 + Int64(i), editedAt: nil, text: "Post \(i)", links: links)]
        }
        let full = VoiciPageState(profile: VoiciProfile(displayName: "Ana", bio: "", avatar: nil, theme: "classic", links: []),
                                  acceptsMessages: 1, chunks: chunks, issuedAt: now)
        let pieces = try XCTUnwrap(try VoiciOwner.pieces(full, images: [cardSha: card]))
        let phone = VoiciPage.phoneChunksFor(chunks.count)
        XCTAssertEqual(phone, 2)
        let inbox = try VoiciMessages.deriveVoiciInboxKey(umk: umk, pageId: pageId, inboxEpoch: 1)
        let sign = try VoiciMessages.deriveVoiciOwnerSignKey(umk: umk, pageId: pageId, inboxEpoch: 1)
        let body = VoiciPageIndex(username: "ana", pageId: pageId, seq: 1, issuedAt: now, acceptsMessages: 1, inboxEpoch: 1,
                                  inboxPub: CanonicalJson.hex(inbox.publicKey), ownerSignPub: CanonicalJson.hex(sign.publicKey),
                                  pieces: pieces.map(\.ref), signerKind: "admin-root", phoneChunks: Int64(phone))
        let idx = try VoiciPage.signVoiciPageIndex(body, signerSeed: admin)
        let adminPub = CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: admin))
        XCTAssertEqual(VoiciPage.checkVoiciPublish(idx.json, username: "ana", sensitiveKind: "admin-root", sensitivePub: adminPub,
                                                   storedSeq: 0, storedPageId: nil, now: now).code, "ok")
        var unCapped = body
        unCapped.phoneChunks = nil
        let noPhone = try VoiciPage.signVoiciPageIndex(unCapped, signerSeed: admin)
        XCTAssertEqual(VoiciPage.checkVoiciPublish(noPhone.json, username: "ana", sensitiveKind: "admin-root", sensitivePub: adminPub,
                                                   storedSeq: 0, storedPageId: nil, now: now).code, "too-many-chunks")

        let byRole = Dictionary(uniqueKeysWithValues: pieces.map { ($0.ref.role, $0) })
        let image: (String) -> [UInt8]? = { $0 == cardSha ? card : nil }
        XCTAssertEqual(VoiciOwner.phonePiece(byRole["chunk-0"]!.ref.sha256, index: idx, state: full, image: image), byRole["chunk-0"]!.bytes)
        XCTAssertEqual(VoiciOwner.phonePiece(cardSha, index: idx, state: full, image: image), card)
        XCTAssertNil(VoiciOwner.phonePiece(byRole["chunk-5"]!.ref.sha256, index: idx, state: full, image: image))
        XCTAssertNil(VoiciOwner.phonePiece(byRole["profile"]!.ref.sha256, index: idx, state: full, image: image))
        XCTAssertNil(VoiciOwner.phonePiece(byRole["chunk-0"]!.ref.sha256, index: noPhone, state: full, image: image))

        let onCom = Dictionary(uniqueKeysWithValues: pieces.filter { !idx.isPhoneChunk($0.ref.role) }.map { ($0.ref.sha256, $0.bytes) })
        struct Missing: Error {}
        let read = try await VoiciOwner.content(idx) { ref in
            guard let b = onCom[ref.sha256] else { throw Missing() }
            return b
        }
        let second = try XCTUnwrap(read)
        XCTAssertEqual(second.chunks.prefix(2).map(\.count), [0, 0])
        XCTAssertEqual(Array(second.chunks.dropFirst(2)), Array(chunks.dropFirst(2)))
        let carried = VoiciOwner.carriedChunks(idx, state: second)
        XCTAssertEqual(carried.map(\.role), ["chunk-0", "chunk-1"])
        XCTAssertTrue(VoiciOwner.carriedChunks(idx, state: full).isEmpty)
        let again = try XCTUnwrap(try VoiciOwner.pieces(second, images: [:], listed: idx.pieces, carried: carried))
        XCTAssertEqual(Set(again.map(\.ref.key)), Set(pieces.map(\.ref.key)))
        XCTAssertTrue(again.filter { idx.isPhoneChunk($0.ref.role) || $0.ref.role.hasPrefix("card-") }.allSatisfy { $0.bytes.isEmpty })
        let broken = try? await VoiciOwner.content(idx) { ref in
            guard ref.role != "chunk-5", let b = onCom[ref.sha256] else { throw Missing() }
            return b
        }
        XCTAssertNil(broken)
    }

    func testPublishThenSeqConflictCarriesTheStoredIndex() async throws {
        let m = try mock()
        let post = VoiciPost(id: String(repeating: "b2", count: 16), createdAt: now - 5, editedAt: nil, text: "First post", links: [])
        let idx = try await publish(m, state([post]), seq: 1)
        // The content read back verifies and parses.
        let content = try await VoiciOwner.content(idx) { try await m.piece(pageId: self.pageId, sha256: $0.sha256) }
        XCTAssertEqual(content?.chunks.first?.first?.text, "First post")
        do {
            _ = try await publish(m, state(), seq: 1)
            XCTFail("a second seq 1 must be refused")
        } catch let e as VoiciComError {
            XCTAssertEqual(e.code, "seq-conflict")
            XCTAssertEqual(e.stored.flatMap { VoiciPage.parseVoiciPageIndex($0) }?.seq, 1)
        }
    }

    func testAVisitorsMessageOpensAndTheReplyReachesTheVisitor() async throws {
        let m = try mock()
        let idx = try await publish(m, state(), seq: 1)
        let visitor = try MockVoiciVisitor(secret: [UInt8](repeating: 9, count: 32), pageId: pageId, origin: "https://voi.ci", now: now)
        let inboxPub = try CanonicalJson.hexToBytes(idx.inboxPub)
        try await m.send(envelope: try visitor.message("Hi Ana, love the page", inboxPub: inboxPub, seq: 1, sentAt: now), direct: false)
        let inbox = try VoiciMessages.deriveVoiciInboxKey(umk: umk, pageId: pageId, inboxEpoch: 1)
        let items = try await m.inbox(username: "ana", since: "").items
        var convs = VoiciOwner.conversations(items: items, pageId: pageId, ownerSignPub: idx.ownerSignPub, inboxSeed: inbox.seed,
                                             caKeys: [MockVoiciComClient.caPub], origin: "https://voi.ci")
        XCTAssertEqual(convs.count, 1)
        XCTAssertEqual(convs[0].messages.map(\.text), ["Hi Ana, love the page"])
        XCTAssertEqual(convs[0].pseudonymPub, visitor.pseudonymPub)
        // A CA the app does not trust: dropped before the body is opened.
        XCTAssertTrue(VoiciOwner.conversations(items: items, pageId: pageId, ownerSignPub: idx.ownerSignPub, inboxSeed: inbox.seed,
                                               caKeys: [String(repeating: "00", count: 32)], origin: "https://voi.ci").isEmpty)
        // Another origin's delegation: dropped.
        XCTAssertTrue(VoiciOwner.conversations(items: items, pageId: pageId, ownerSignPub: idx.ownerSignPub, inboxSeed: inbox.seed,
                                               caKeys: [MockVoiciComClient.caPub], origin: "https://gym.voi.ci").isEmpty)
        // Reply: sealed to the visitor's thread key, signed by the owner key.
        let sign = try VoiciMessages.deriveVoiciOwnerSignKey(umk: umk, pageId: pageId, inboxEpoch: 1)
        let reply = try VoiciOwner.reply(text: "Thanks!", replyTo: convs[0].messages[0].msgId, conversation: convs[0], pageId: pageId, pageSeq: 1,
                                         ownerSign: (sign.seed, idx.ownerSignPub), inboxPub: inboxPub,
                                         seq: VoiciOwner.nextReplySeq(convs[0], ownerSignPub: idx.ownerSignPub), now: now + 1)
        try await m.send(envelope: reply.json, direct: false)
        let body = try XCTUnwrap(CanonicalJson.b64Decode(reply.bodyB64))
        let opened = try VoiciMessages.openVoiciBody(body, conv: reply.conv, msgId: reply.msgId, recipientSeed: visitor.thread.seed)
        XCTAssertEqual(opened.value?.text, "Thanks!")
        XCTAssertTrue(VoiciMessages.checkVoiciReply(reply.json, pageId: pageId, ownerSignPub: idx.ownerSignPub).isOk)
        convs = VoiciOwner.conversations(items: try await m.inbox(username: "ana", since: "").items, pageId: pageId, ownerSignPub: idx.ownerSignPub,
                                         inboxSeed: inbox.seed, caKeys: [MockVoiciComClient.caPub], origin: "https://voi.ci")
        XCTAssertEqual(convs[0].messages.map(\.fromOwner), [false, true])
        XCTAssertTrue(convs[0].ownerReplied)
    }

    func testDraftGrantChecksTheAccountsKeyAndTheSigner() throws {
        let device = Curve25519.Signing.PrivateKey()
        let devicePub = CanonicalJson.hex(Array(device.publicKey.rawRepresentation))
        let g = DeviceCapabilityGrantEnvelope(grantId: "g1", username: "ana", deviceId: "dev-1", devicePubKeyHex: devicePub,
                                              scopes: ["browse", "view-directory"], issuedAt: now - 10, expiresAt: now + 1_000)
        let sig = try CanonicalJson.ed25519SignHex(Array(g.canonicalBytes()), seed: admin)
        let grant: JSONValue = ["grantId": "g1", "username": "ana", "deviceId": "dev-1", "devicePubHex": .string(devicePub),
                                "scopes": ["browse", "view-directory"], "issuedAt": .int(now - 10), "expiresAt": .int(now + 1_000)]
        let adminPub = CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: admin))
        XCTAssertTrue(VoiciOwner.checkDraftGrant(grant, signature: sig, devicePub: devicePub, username: "ana", accountKeys: [adminPub], now: now))
        XCTAssertFalse(VoiciOwner.checkDraftGrant(grant, signature: sig, devicePub: String(repeating: "00", count: 32), username: "ana", accountKeys: [adminPub], now: now))
        XCTAssertFalse(VoiciOwner.checkDraftGrant(grant, signature: sig, devicePub: devicePub, username: "bob", accountKeys: [adminPub], now: now))
        XCTAssertFalse(VoiciOwner.checkDraftGrant(grant, signature: sig, devicePub: devicePub, username: "ana", accountKeys: [adminPub], now: now + 2_000))
        // A draft envelope built by the device verifies under checkVoiciDraft with that grant check.
        let op = VoiciDraftOp(opId: String(repeating: "c3", count: 16), op: "accept-messages", at: now, deviceId: "dev-1", accepts: 1)
        let draftsKey = VoiciMessages.deriveVoiciDraftsKey(umk: umk)
        let env = try VoiciOwner.draft(op: op, username: "ana", draftsKey: draftsKey, deviceSeed: Array(device.rawRepresentation),
                                       grant: grant, grantSignature: sig, seq: 1, now: now)
        let checked = VoiciMessages.checkVoiciDraft(env.json, username: "ana", checkGrant: { g, s, d in
            VoiciOwner.checkDraftGrant(g, signature: s, devicePub: d, username: "ana", accountKeys: [adminPub], now: self.now)
        }, freshAt: now)
        let e = try XCTUnwrap(checked.value)
        XCTAssertEqual(VoiciMessages.openVoiciDraft(draftsKey: draftsKey, username: "ana", opId: e.msgId, bodyBytes: CanonicalJson.b64Decode(e.bodyB64)!), op)
    }

    func testDeliveryLimiter() {
        let l = VoiciDeliveryLimiter()
        for _ in 0..<20 { XCTAssertTrue(l.admit(from: "a", now: now)) }
        XCTAssertFalse(l.admit(from: "a", now: now))
        XCTAssertTrue(l.admit(from: "b", now: now))
        XCTAssertTrue(l.admit(from: "a", now: now + 60_001))
    }

    /// Sign-out (§6.4): P's revoke with the page when no delegation was kept, the delegation when it was; any refusal,
    /// 404 included, throws so the app keeps the site and says so.
    func testSignOutSendsPsRevokeAndFailsOnAnyRefusal() async throws {
        let m = try mock()
        let p = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: VoiciMessages.deriveMessagesSecret(umk: umk), pageId: pageId)
        let b = "04" + String(repeating: "ab", count: 64)
        try await VoiciSignOut.send(m, pageId: pageId, delegatePub: b, pseudonymSeed: p.seed, kept: nil, now: now)
        let body = try XCTUnwrap(m.revokes.last)
        XCTAssertEqual(body["pageId"]?.string, pageId)
        XCTAssertEqual(body["principalPub"]?.string, CanonicalJson.hex(p.publicKey))
        XCTAssertNil(body["delegation"])
        for status in [404, 403, 500] {
            m.revokeRefusal = (status, "unknown-delegate")
            do {
                try await VoiciSignOut.send(m, pageId: pageId, delegatePub: b, pseudonymSeed: p.seed, kept: nil, now: now)
                XCTFail("a \(status) must not read as signed out")
            } catch let e as VoiciComError {
                XCTAssertEqual(e.status, status)
            }
        }
        XCTAssertEqual(m.revokes.count, 1)
    }
}

final class VoiciSignInLinkTests: XCTestCase {
    func testFragmentAndQueryFormsParse() throws {
        let k = Base64URL.encode(Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation)
        let sid = Base64URL.encode(Data(repeating: 7, count: 16))
        let d = CanonicalJson.hex(Array(P256.Signing.PrivateKey().publicKey.x963Representation))
        let fields = "s=\(sid)&k=\(k)&p=\(String(repeating: "07", count: 16))&u=river-otter&d=\(d)&n=\(String(repeating: "ab", count: 16))"
        let frag = try XCTUnwrap(VoiciSignInLink.parse("https://flagshipserver.com/voici-sign-in#\(fields)", origin: "https://voi.ci"))
        XCTAssertEqual(frag.request.username, "river-otter")
        XCTAssertEqual(frag.request.delegatePub, d)
        XCTAssertNotNil(VoiciSignInLink.parse("https://flagshipserver.com/voici-sign-in?\(fields)", origin: "https://voi.ci"))
        XCTAssertNil(VoiciSignInLink.parse("https://evil.example/voici-sign-in#\(fields)", origin: "https://voi.ci"))
        XCTAssertNil(VoiciSignInLink.parse("https://flagshipserver.com/voici-sign-in#\(fields.replacingOccurrences(of: "&n=", with: "&x="))"))
        if case .voiciSignIn = DeepLink.parse(URL(string: "flagship://voici-sign-in?\(fields)")!) {} else { XCTFail("custom scheme form") }
    }
}
