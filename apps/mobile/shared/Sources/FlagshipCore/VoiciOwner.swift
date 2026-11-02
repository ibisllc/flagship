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
    }

    /// The pieces a page state publishes as: the profile, each chunk, the avatar and every card image the posts name.
    /// `images` holds the JPEG bytes by SHA-256; nil when one the content names is missing.
    public static func pieces(_ state: VoiciPageState, images: [String: [UInt8]]) throws -> [Piece]? {
        var out: [Piece] = []
        let profile = try CanonicalJson.canonicalJsonBytes(state.profile.json)
        out.append(Piece(ref: VoiciPieceRef(role: "profile", sha256: CanonicalJson.sha256Hex(profile), size: Int64(profile.count)), bytes: profile))
        for (n, posts) in state.chunks.enumerated() {
            let b = try CanonicalJson.canonicalJsonBytes(VoiciChunk(chunk: Int64(n), posts: posts).json)
            out.append(Piece(ref: VoiciPieceRef(role: "chunk-\(n)", sha256: CanonicalJson.sha256Hex(b), size: Int64(b.count)), bytes: b))
        }
        if let a = state.profile.avatar {
            guard let b = images[a] else { return nil }
            out.append(Piece(ref: VoiciPieceRef(role: "avatar", sha256: a, size: Int64(b.count)), bytes: b))
        }
        var cards = Set<String>()
        for c in state.chunks { for p in c { for l in p.links { if let i = l.card?.image { cards.insert(i) } } } }
        for sha in cards.sorted() {
            guard let b = images[sha] else { return nil }
            out.append(Piece(ref: VoiciPieceRef(role: VoiciPage.voiciCardRole(sha), sha256: sha, size: Int64(b.count)), bytes: b))
        }
        return out
    }

    /// The image hashes a page state names (avatar and card images).
    public static func imageHashes(_ state: VoiciPageState) -> Set<String> {
        var s = Set<String>()
        if let a = state.profile.avatar { s.insert(a) }
        for c in state.chunks { for p in c { for l in p.links { if let i = l.card?.image { s.insert(i) } } } }
        return s
    }

    /// A verified index's content: the profile and every chunk, each checked against its hash and size.
    public static func content(_ index: VoiciPageIndex, fetch: (VoiciPieceRef) async throws -> [UInt8]) async throws -> VoiciPageState? {
        var profile: VoiciProfile?
        var chunks: [(Int64, [VoiciPost])] = []
        for p in index.pieces where p.role == "profile" || p.role.hasPrefix("chunk-") {
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
                      let body = CanonicalJson.b64Decode(ok.envelope.bodyB64),
                      case .ok(let pt)? = try? VoiciMessages.openVoiciBody(body, conv: ok.envelope.conv, msgId: ok.envelope.msgId, recipientSeed: inboxSeed)
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
            let seqs = Set(c.messages.filter { !$0.fromOwner }.map(\.seq))
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
