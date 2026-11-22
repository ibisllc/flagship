import Foundation

/// The page owner's side of Messages, as pure functions over chunk A's primitives (docs/voici-and-messages.md §5, §7,
/// §8.2, §12.1): the pieces of a page, the conversations an inbox holds, and the phone endpoint's delivery check.

/// One message of a conversation, after every check and the decryption.
public struct VoiciThreadMessage: Equatable, Sendable, Identifiable {
    public enum Receipt: String, Equatable, Sendable { case sent, delivered, deliveredToPhone = "delivered-to-phone" }
    public var msgId: String
    public var conv: String
    public var fromOwner: Bool
    public var from: String
    public var seq: Int64
    public var text: String
    public var replyTo: String?
    public var sentAt: Int64
    public var receipt: Receipt
    /// The wire envelope as received (what a report sends).
    public var envelope: JSONValue
    public var id: String { msgId }
}

public struct VoiciConversation: Equatable, Sendable, Identifiable {
    public var conv: String
    public var pseudonymPub: String
    /// The visitor's thread key from the newest verified thread statement ("" while only replies are known).
    public var threadPub: String
    public var messages: [VoiciThreadMessage]
    /// A visitor's `seq` skips a number: "Some messages haven't arrived yet".
    public var hasGap: Bool
    /// The newest reveal or unreveal the visitor sent (docs/voici-calls.md "Reveal who I am"), not yet checked: the app
    /// checks a reveal against the page key `.com` serves for its username before it shows the pill.
    public var control: VoiciConversations.Control?
    /// The seq numbers the controls used (they count toward the visitor's sequence, so no gap shows).
    public var controlSeqs: [Int64] = []
    var controlAt: Int64?
    public var id: String { conv }
    public init(conv: String, pseudonymPub: String, threadPub: String, messages: [VoiciThreadMessage], hasGap: Bool) {
        self.conv = conv; self.pseudonymPub = pseudonymPub; self.threadPub = threadPub; self.messages = messages; self.hasGap = hasGap
    }
    public var lastAt: Int64 { messages.last?.sentAt ?? 0 }
    public var ownerReplied: Bool { messages.contains { $0.fromOwner } }
}

public enum VoiciOwner {
    /// A piece of the page with its bytes.
    public struct Piece: Equatable, Sendable {
        public var ref: VoiciPieceRef
        public var bytes: [UInt8]
        public init(ref: VoiciPieceRef, bytes: [UInt8]) { self.ref = ref; self.bytes = bytes }
    }

    /// The pieces a page state publishes as: the profile, each chunk, the avatar and every card image the posts name.
    /// `images` holds the JPEG bytes by SHA-256; nil when one the content names is missing and `listed` doesn't name it.
    /// Capped server copy (docs/voici-and-messages.md §2.7a): `listed` is the index this publish replaces; a chunk in
    /// `carried` (one this device doesn't hold) goes out as its listed ref with no bytes, and so do the listed card
    /// images no chunk this device holds names. An image already listed may come without its bytes (empty: not uploaded).
    public static func pieces(_ state: VoiciPageState, images: [String: [UInt8]], listed: [VoiciPieceRef] = [],
                              carried: [VoiciPieceRef] = []) throws -> [Piece]? {
        var out: [Piece] = []
        let profile = try CanonicalJson.canonicalJsonBytes(state.profile.json)
        out.append(Piece(ref: VoiciPieceRef(role: "profile", sha256: CanonicalJson.sha256Hex(profile), size: Int64(profile.count)), bytes: profile))
        let carriedByRole = Dictionary(carried.map { ($0.role, $0) }, uniquingKeysWith: { a, _ in a })
        var cards = Set<String>()
        for (n, posts) in state.chunks.enumerated() {
            if let keep = carriedByRole["chunk-\(n)"], posts.isEmpty {
                out.append(Piece(ref: keep, bytes: []))
                continue
            }
            let b = try CanonicalJson.canonicalJsonBytes(VoiciChunk(chunk: Int64(n), posts: posts).json)
            out.append(Piece(ref: VoiciPieceRef(role: "chunk-\(n)", sha256: CanonicalJson.sha256Hex(b), size: Int64(b.count)), bytes: b))
            for p in posts { for l in p.links { if let i = l.card?.image { cards.insert(i) } } }
        }
        let listedBySha = Dictionary(listed.map { ($0.sha256, $0) }, uniquingKeysWith: { a, _ in a })
        func image(_ role: String, _ sha: String) -> Piece? {
            if let b = images[sha] { return Piece(ref: VoiciPieceRef(role: role, sha256: sha, size: Int64(b.count)), bytes: b) }
            if let l = listedBySha[sha] { return Piece(ref: VoiciPieceRef(role: role, sha256: sha, size: l.size), bytes: []) }
            return nil
        }
        if let a = state.profile.avatar {
            guard let p = image("avatar", a) else { return nil }
            out.append(p)
        }
        for sha in cards.sorted() {
            guard let p = image(VoiciPage.voiciCardRole(sha), sha) else { return nil }
            out.append(p)
        }
        if !carriedByRole.isEmpty {
            for l in listed where l.role.hasPrefix("card-") && !cards.contains(l.sha256) { out.append(Piece(ref: l, bytes: [])) }
        }
        return out
    }

    /// One chunk's canonical bytes from a page state, or nil when the state has no chunk n.
    public static func chunkBytes(_ state: VoiciPageState, _ n: Int) -> [UInt8]? {
        guard n >= 0, n < state.chunks.count else { return nil }
        return try? CanonicalJson.canonicalJsonBytes(VoiciChunk(chunk: Int64(n), posts: state.chunks[n]).json)
    }

    /// The phone-only chunks of `index` this device doesn't hold: `state` (its copy of that index's content) can't
    /// produce their listed bytes. A publish carries these refs unchanged (§2.7a).
    public static func carriedChunks(_ index: VoiciPageIndex?, state: VoiciPageState?) -> [VoiciPieceRef] {
        guard let index, (index.phoneChunks ?? 0) > 0 else { return [] }
        return index.pieces.filter { ref in
            guard index.isPhoneChunk(ref.role), let n = Int(ref.role.dropFirst(6)) else { return false }
            guard let state, let b = chunkBytes(state, n) else { return true }
            return CanonicalJson.sha256Hex(b) != ref.sha256
        }
    }

    /// What the phone endpoint answers for `GET /api/phone/voici-piece/<sha256>` (§2.7a): the bytes of a phone-only
    /// chunk of `index`, regenerated from this phone's copy `state`, or of a card image (from `image`) on a page with
    /// phone-only chunks; checked against the listed hash and size. Nil for anything else (404).
    public static func phonePiece(_ sha256: String, index: VoiciPageIndex, state: VoiciPageState?, image: (String) -> [UInt8]?) -> [UInt8]? {
        guard (index.phoneChunks ?? 0) > 0, let ref = index.pieces.first(where: { $0.sha256 == sha256 }) else { return nil }
        var bytes: [UInt8]?
        if index.isPhoneChunk(ref.role), let n = Int(ref.role.dropFirst(6)), let state {
            bytes = chunkBytes(state, n)
        } else if ref.role.hasPrefix("card-") {
            bytes = image(sha256)
        }
        guard let b = bytes, Int64(b.count) == ref.size, CanonicalJson.sha256Hex(b) == ref.sha256 else { return nil }
        return b
    }

    /// The image hashes a page state names (avatar and card images).
    public static func imageHashes(_ state: VoiciPageState) -> Set<String> {
        var s = Set<String>()
        if let a = state.profile.avatar { s.insert(a) }
        for c in state.chunks { for p in c { for l in p.links { if let i = l.card?.image { s.insert(i) } } } }
        return s
    }

    /// A verified index's content: the profile and every chunk, each checked against its hash and size. A phone-only
    /// chunk (§2.7a) that `fetch` can't give (it throws or answers other bytes) becomes an empty placeholder; the next
    /// publish carries its listed ref (`carriedChunks`).
    public static func content(_ index: VoiciPageIndex, fetch: (VoiciPieceRef) async throws -> [UInt8]) async throws -> VoiciPageState? {
        var profile: VoiciProfile?
        var chunks: [(Int64, [VoiciPost])] = []
        var placeholders = false
        for p in index.pieces where p.role == "profile" || p.role.hasPrefix("chunk-") {
            if index.isPhoneChunk(p.role), let n = Int64(p.role.dropFirst(6)) {
                let b = try? await fetch(p)
                guard let b, Int64(b.count) == p.size, CanonicalJson.sha256Hex(b) == p.sha256, let c = VoiciPage.parseVoiciChunkPiece(b, n: n) else {
                    chunks.append((n, []))
                    placeholders = true
                    continue
                }
                chunks.append((n, c.posts))
                continue
            }
            let b = try await fetch(p)
            guard Int64(b.count) == p.size, CanonicalJson.sha256Hex(b) == p.sha256 else { return nil }
            if p.role == "profile" {
                profile = VoiciPage.parseVoiciProfilePiece(b)
            } else if let n = Int64(p.role.dropFirst(6)), let c = VoiciPage.parseVoiciChunkPiece(b, n: n) {
                chunks.append((n, c.posts))
            } else {
                return nil
            }
        }
        guard let profile else { return nil }
        let ordered = chunks.sorted { $0.0 < $1.0 }
        let state = VoiciPageState(profile: profile, acceptsMessages: index.acceptsMessages, chunks: ordered.map(\.1), issuedAt: index.issuedAt)
        if placeholders {
            // Not every chunk is here: the avatar must match and every card a held chunk names must be listed.
            let listed = Set(index.pieces.filter { $0.role.hasPrefix("card-") }.map(\.sha256))
            guard (profile.avatar ?? "") == (index.pieces.first { $0.role == "avatar" }?.sha256 ?? ""),
                  ordered.allSatisfy({ $0.1.allSatisfy { $0.links.allSatisfy { $0.card?.image.map(listed.contains) ?? true } } }) else { return nil }
            return state
        }
        guard VoiciPage.voiciPieceRefsOk(index, profile: profile, chunks: ordered.map { VoiciChunk(chunk: $0.0, posts: $0.1) }) else { return nil }
        return state
    }

    /// Builds the conversations an inbox holds. Every envelope is checked (signatures, the attestation chain and the
    /// delegation at the time it was sent: reading history checks no freshness) before its body is opened with the
    /// inbox key; any failure drops it. Duplicates (conv, msgId) are dropped. Ordered by (sentAt, msgId).
    public static func conversations(items: [VoiciInboxItem], pageId: String, ownerSignPub: String, inboxSeed: [UInt8],
                                     caKeys: [String], origin: String, deliveredToPhone: Set<String> = []) -> [VoiciConversation] {
        var byConv: [String: VoiciConversation] = [:]
        var seen = Set<String>()
        for item in items {
            let kind = item.envelope["kind"]?.string
            if kind == "voici-message" {
                let sentAt = item.envelope["sentAt"]?.time ?? 0
                let ctx = VoiciMessageCheckContext(pageId: pageId, acceptsMessages: true, origin: origin, caKeys: caKeys, now: sentAt)
                guard case .ok(let ok) = VoiciMessages.checkVoiciMessage(item.envelope, ctx), !seen.contains(ok.envelope.conv + ok.envelope.msgId),
                      let body = CanonicalJson.b64Decode(ok.envelope.bodyB64) else { continue }
                if let control = VoiciMessages.openVoiciControl(body, conv: ok.envelope.conv, msgId: ok.envelope.msgId, recipientSeed: inboxSeed) {
                    seen.insert(ok.envelope.conv + ok.envelope.msgId)
                    var c = byConv[ok.envelope.conv] ?? VoiciConversation(conv: ok.envelope.conv, pseudonymPub: ok.envelope.from, threadPub: "", messages: [], hasGap: false)
                    c.threadPub = ok.cred.threadStmt.threadPub
                    c.controlSeqs.append(ok.envelope.seq)
                    if (c.controlAt ?? -1) <= ok.envelope.sentAt { c.control = control; c.controlAt = ok.envelope.sentAt }
                    byConv[ok.envelope.conv] = c
                    continue
                }
                guard case .ok(let pt)? = try? VoiciMessages.openVoiciBody(body, conv: ok.envelope.conv, msgId: ok.envelope.msgId, recipientSeed: inboxSeed)
                else { continue }
                seen.insert(ok.envelope.conv + ok.envelope.msgId)
                var c = byConv[ok.envelope.conv] ?? VoiciConversation(conv: ok.envelope.conv, pseudonymPub: ok.envelope.from, threadPub: "", messages: [], hasGap: false)
                c.threadPub = ok.cred.threadStmt.threadPub
                let receipt: VoiciThreadMessage.Receipt = deliveredToPhone.contains(ok.envelope.msgId) || item.direct ? .deliveredToPhone : .delivered
                c.messages.append(VoiciThreadMessage(msgId: ok.envelope.msgId, conv: ok.envelope.conv, fromOwner: false, from: ok.envelope.from,
                                                     seq: ok.envelope.seq, text: pt.text, replyTo: pt.replyTo, sentAt: ok.envelope.sentAt,
                                                     receipt: receipt, envelope: item.envelope))
                byConv[ok.envelope.conv] = c
            } else if kind == "voici-reply" {
                guard case .ok(let ok) = VoiciMessages.checkVoiciReply(item.envelope, pageId: pageId, ownerSignPub: ownerSignPub),
                      !seen.contains(ok.envelope.conv + ok.envelope.msgId), let body = CanonicalJson.b64Decode(ok.envelope.bodyB64),
                      case .ok(let pt)? = try? VoiciMessages.openVoiciBody(body, conv: ok.envelope.conv, msgId: ok.envelope.msgId, recipientSeed: inboxSeed)
                else { continue }
                seen.insert(ok.envelope.conv + ok.envelope.msgId)
                var c = byConv[ok.envelope.conv] ?? VoiciConversation(conv: ok.envelope.conv, pseudonymPub: "", threadPub: "", messages: [], hasGap: false)
                c.messages.append(VoiciThreadMessage(msgId: ok.envelope.msgId, conv: ok.envelope.conv, fromOwner: true, from: ok.envelope.from,
                                                     seq: ok.envelope.seq, text: pt.text, replyTo: pt.replyTo, sentAt: ok.envelope.sentAt,
                                                     receipt: item.fetchedAt != nil ? .delivered : .sent, envelope: item.envelope))
                byConv[ok.envelope.conv] = c
            }
        }
        return byConv.values.compactMap { conv -> VoiciConversation? in
            // A conversation is about a visitor: replies alone (to a visitor never seen) are not shown.
            guard !conv.pseudonymPub.isEmpty else { return nil }
            var c = conv
            c.messages.sort { $0.sentAt != $1.sentAt ? $0.sentAt < $1.sentAt : CanonicalJson.utf16Less($0.msgId, $1.msgId) }
            let seqs = Set(c.messages.filter { !$0.fromOwner }.map(\.seq) + c.controlSeqs)
            c.hasGap = (seqs.max() ?? 0) > Int64(seqs.count)
            return c
        }.sorted { $0.lastAt != $1.lastAt ? $0.lastAt > $1.lastAt : $0.conv < $1.conv }
    }

    /// The owner's next `seq` toward one conversation.
    public static func nextReplySeq(_ c: VoiciConversation, ownerSignPub: String) -> Int64 {
        (c.messages.filter { $0.fromOwner && $0.from == ownerSignPub }.map(\.seq).max() ?? 0) + 1
    }

    /// A signed `voici-reply` (§7.4): sealed to the visitor's thread key and the owner's inbox key, signed by the owner
    /// messages key, naming the page `seq` the visitor checks the key against.
    public static func reply(text: String, replyTo: String?, conversation c: VoiciConversation, pageId: String, pageSeq: Int64,
                             ownerSign: (seed: [UInt8], pub: String), inboxPub: [UInt8], seq: Int64, now: Int64) throws -> WebEnvelope {
        let msgId = CanonicalJson.hex(VoiciMessages.random(16))
        let body = try VoiciMessages.sealVoiciBody(conv: c.conv, msgId: msgId, sentAt: now, fromPub: ownerSign.pub,
                                                   recipients: [try CanonicalJson.hexToBytes(c.threadPub), inboxPub],
                                                   plaintext: VoiciPlaintext(text: text, replyTo: replyTo))
        let env = WebEnvelope(kind: "voici-reply", audience: pageId, conv: c.conv, from: ownerSign.pub, msgId: msgId, seq: seq, sentAt: now,
                              bodyB64: CanonicalJson.b64Encode(body), cred: ["pageSeq": .int(pageSeq)])
        return try WebEnvelope.signWebEnvelopeEd25519(env, seed: ownerSign.seed)
    }

    /// A signed `voici-draft` from this device (§5.2): msgId is the opId, the cred is the device's own grant.
    public static func draft(op: VoiciDraftOp, username: String, draftsKey: [UInt8], deviceSeed: [UInt8], grant: JSONValue,
                             grantSignature: String, seq: Int64, now: Int64) throws -> WebEnvelope {
        let body = try VoiciMessages.sealVoiciDraft(draftsKey: draftsKey, username: username, op: op)
        let env = WebEnvelope(kind: "voici-draft", audience: username, conv: "", from: CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: deviceSeed)),
                              msgId: op.opId, seq: seq, sentAt: now, bodyB64: CanonicalJson.b64Encode(body),
                              cred: ["grant": grant, "grantSignature": .string(grantSignature)])
        return try WebEnvelope.signWebEnvelopeEd25519(env, seed: deviceSeed)
    }

    /// The grant check a draft's receiver runs (§5.2): the grant names this account and the envelope's signer, has not
    /// ended, and verifies under one of the account's own keys (the admin root, else the IRK).
    public static func checkDraftGrant(_ grant: JSONValue, signature: String, devicePub: String, username: String,
                                       accountKeys: [String], now: Int64) -> Bool {
        guard let g = grant.object, let grantId = g["grantId"]?.string, g["username"]?.string?.lowercased() == username.lowercased(),
              let deviceId = g["deviceId"]?.string, let pub = g["devicePubHex"]?.string, CanonicalJson.same(pub.lowercased(), devicePub),
              let scopes = g["scopes"]?.array?.compactMap(\.string), let issuedAt = g["issuedAt"]?.time, let expiresAt = g["expiresAt"]?.time,
              expiresAt > now else { return false }
        let bytes = DeviceCapabilityGrantEnvelope(grantId: grantId, username: g["username"]!.string!, deviceId: deviceId, devicePubKeyHex: pub,
                                                  scopes: scopes, issuedAt: issuedAt, expiresAt: expiresAt).canonicalBytes()
        return accountKeys.contains { CanonicalJson.ed25519VerifyHex(signature, Array(bytes), $0) }
    }
}

/// The phone endpoint's per-sender and overall delivery budget (§8.2): 20 a minute per `from`, 120 a minute in all.
public final class VoiciDeliveryLimiter: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [Int64] = []
    private var bySender: [String: [Int64]] = [:]
    public init() {}

    /// Counts one delivery at `now` (ms) and answers whether it is within the budget.
    public func admit(from: String, now: Int64) -> Bool {
        lock.withLock {
            let floor = now - 60_000
            all.removeAll { $0 <= floor }
            var mine = (bySender[from] ?? []).filter { $0 > floor }
            if bySender.count > 512 { bySender = bySender.filter { !$0.value.allSatisfy { $0 <= floor } } }
            guard all.count < VoiciPhoneWeb.deliverPerMinute, mine.count < VoiciPhoneWeb.deliverPerSenderPerMinute else { return false }
            all.append(now)
            mine.append(now)
            bySender[from] = mine
            return true
        }
    }
}

extension VoiciPost: Identifiable {}
