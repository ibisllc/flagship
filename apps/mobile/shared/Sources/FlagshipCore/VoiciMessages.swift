import Foundation
import CryptoKit

/// voi.ci Messages (docs/voici-and-messages.md §1, §6-§8): key derivations from the UMK, the conversation id, the
/// sealed body, the thread statement and the receiver's checks for the three web-envelope kinds. Swift twin of the
/// first half of packages/protocol/src/voiciMessages.ts (the rest is VoiciMessagesRecords.swift), pinned by
/// packages/protocol/test-vectors/messages/vectors.json (`derivations`, `threadStatement`, `message`, `reply`,
/// `draft`).
///
/// Derivations (HKDF-SHA256, empty salt, 32 bytes):
///   inbox X-Wing seed   KDF(umk, "flagship/voici-inbox/v1|<pageId>|<inboxEpoch>")
///   owner signing seed  KDF(umk, "flagship/voici-owner-sign/v1|<pageId>|<inboxEpoch>")     Ed25519
///   messages secret     KDF(umk, "flagship/messages-secret/v1")
///   pseudonym seed P    KDF(messagesSecret, "flagship/messages-pseudonym/v1|<pageId>")      Ed25519
///   thread seed T       KDF(messagesSecret, "flagship/messages-thread/v1|<pageId>")         X-Wing
///   drafts key          KDF(umk, "flagship/voici-drafts/v1")                                AES-256-GCM
///   state key           KDF(umk, "flagship/messages-state/v1")                              AES-256-GCM
///   conv                SHA-256 hex of "flagship/voici-conv/v1|<pageId>|<Ppub hex>"
/// Sealed body = canonicalJson({suite: hybrid-seal suite tag, nonce, ct, wraps:[{keyId, sealed}] x2}); ct =
/// AES-256-GCM(CEK, nonce, aad "flagship/voici-body/v1|<conv>|<msgId>", canonicalJson({v:1, text, replyTo}));
/// each wrap = PqHybrid seal of the CEK, purpose "flagship/voici-cek/v1", context [conv, msgId], senderKeyId =
/// SHA-256(raw from key), issuedAt = sentAt. Order: message [inbox, T], reply [T, inbox].
/// Thread statement: flagship/voici-thread-key/v1|<pageId>|<Ppub>|<Tpub>|<issuedAt>, Ed25519 by P.
///
/// Public API: VoiciPlaintext, VoiciSealRandomness, VoiciSealedBody, VoiciOpenRefusal, VoiciThreadStatement,
/// VoiciMessageCred, VoiciCheckRefusal, VoiciMessageCheckContext, and the VoiciMessages namespace: the tag
/// constants, sendSkewMs, draft and state caps, deriveVoiciInboxKey, deriveVoiciOwnerSignKey, deriveMessagesSecret,
/// deriveMessagesPseudonymKey, deriveMessagesThreadKey, deriveVoiciDraftsKey, deriveMessagesStateKey, voiciConv,
/// sealVoiciBody, parseVoiciSealedBody, openVoiciBody, canonicalVoiciThreadStatement, signVoiciThreadStatement,
/// parseVoiciThreadStatement, checkVoiciMessage, checkVoiciReply, checkVoiciDraft.
public struct VoiciPlaintext: Equatable, Sendable {
    public var text: String
    public var replyTo: String?
    public init(text: String, replyTo: String?) { self.text = text; self.replyTo = replyTo }
    public var json: JSONValue { ["v": 1, "text": .string(text), "replyTo": .optString(replyTo)] }
}

/// Fixed randomness, for vectors only.
public struct VoiciSealRandomness: Sendable {
    public var cek: [UInt8]
    public var nonce: [UInt8]
    /// One 64-byte X-Wing encapsulation seed per recipient.
    public var eseeds: [[UInt8]]
    public init(cek: [UInt8], nonce: [UInt8], eseeds: [[UInt8]]) { self.cek = cek; self.nonce = nonce; self.eseeds = eseeds }
}

public struct VoiciSealedBody: Equatable, Sendable {
    public var nonce: String
    public var ct: String
    public var wraps: [(keyId: String, sealed: String)]
    public static func == (a: VoiciSealedBody, b: VoiciSealedBody) -> Bool {
        a.nonce == b.nonce && a.ct == b.ct && a.wraps.map(\.keyId) == b.wraps.map(\.keyId) && a.wraps.map(\.sealed) == b.wraps.map(\.sealed)
    }
}

public enum VoiciOpenRefusal: String, Sendable {
    case malformed, noWrap = "no-wrap", decryptFailed = "decrypt-failed", innerSchema = "inner-schema"
    case notString = "not-string", notNfc = "not-nfc", tooShort = "too-short", tooLong = "too-long", control, bidi, bom, surrogate
    case edgeInvisible = "edge-invisible"
}

public struct VoiciThreadStatement: Equatable, Sendable {
    public var pageId: String
    public var pseudonymPub: String
    public var threadPub: String
    public var issuedAt: Int64
    public init(pageId: String, pseudonymPub: String, threadPub: String, issuedAt: Int64) {
        self.pageId = pageId; self.pseudonymPub = pseudonymPub; self.threadPub = threadPub; self.issuedAt = issuedAt
    }
    public var json: JSONValue {
        ["pageId": .string(pageId), "pseudonymPub": .string(pseudonymPub), "threadPub": .string(threadPub), "issuedAt": .int(issuedAt)]
    }
}

public struct VoiciMessageCred: Equatable, Sendable {
    public var attestation: MessagesKeyAttestation
    public var delegation: WebDelegation
    public var delegationSig: String
    public var threadStmt: VoiciThreadStatement
    public var threadSig: String
    public init(attestation: MessagesKeyAttestation, delegation: WebDelegation, delegationSig: String, threadStmt: VoiciThreadStatement, threadSig: String) {
        self.attestation = attestation; self.delegation = delegation; self.delegationSig = delegationSig; self.threadStmt = threadStmt; self.threadSig = threadSig
    }
    public var json: [String: JSONValue] {
        ["attestation": attestation.json, "delegation": delegation.json, "delegationSig": .string(delegationSig),
         "threadStmt": threadStmt.json, "threadSig": .string(threadSig)]
    }
}

public enum VoiciCheckRefusal: String, Sendable {
    case tooLarge = "too-large", malformed, wrongKind = "wrong-kind", wrongAudience = "wrong-audience", notAccepting = "not-accepting"
    case blocked, revoked, rateLimited = "rate-limited", badDelegation = "bad-delegation", badAttestation = "bad-attestation"
    case badThread = "bad-thread", wrongConv = "wrong-conv", badSignature = "bad-signature", badGrant = "bad-grant", stale
}

public struct VoiciMessageCheckContext {
    public var pageId: String
    public var acceptsMessages: Bool
    /// Website origin a delegation must name ("https://voi.ci", gym "https://gym.voi.ci").
    public var origin: String
    /// Authorized CA keys (hex) for the attestation.
    public var caKeys: [String]
    public var now: Int64
    /// Pseudonyms this page blocked and pseudonyms Flagship banned (hex).
    public var blocked: Set<String>?
    /// Revoked browser keys (delegatePub hex).
    public var revoked: Set<String>?
    /// Called after the cheap filters, before any signature check; return a refusal to stop.
    public var rateLimit: ((WebEnvelope) -> VoiciCheckRefusal?)?

    public init(pageId: String, acceptsMessages: Bool, origin: String, caKeys: [String], now: Int64, blocked: Set<String>? = nil,
                revoked: Set<String>? = nil, rateLimit: ((WebEnvelope) -> VoiciCheckRefusal?)? = nil) {
        self.pageId = pageId; self.acceptsMessages = acceptsMessages; self.origin = origin; self.caKeys = caKeys; self.now = now
        self.blocked = blocked; self.revoked = revoked; self.rateLimit = rateLimit
    }
}

public enum VoiciMessages {
    public static let tagVoiciInbox = "flagship/voici-inbox/v1"
    public static let tagVoiciOwnerSign = "flagship/voici-owner-sign/v1"
    public static let tagMessagesSecret = "flagship/messages-secret/v1"
    public static let tagMessagesPseudonym = "flagship/messages-pseudonym/v1"
    public static let tagMessagesThread = "flagship/messages-thread/v1"
    public static let tagVoiciDrafts = "flagship/voici-drafts/v1"
    public static let tagMessagesState = "flagship/messages-state/v1"
    public static let tagVoiciConv = "flagship/voici-conv/v1"
    public static let tagVoiciBody = "flagship/voici-body/v1"
    public static let tagVoiciCek = "flagship/voici-cek/v1"
    public static let tagVoiciThreadKey = "flagship/voici-thread-key/v1"
    public static let tagVoiciAck = "flagship/voici-ack/v1"
    public static let tagVoiciBlock = "flagship/voici-block/v1"
    public static let tagVoiciDraft = "flagship/voici-draft/v1"
    public static let tagVoiciReport = "flagship/voici-report/v1"
    public static let tagVoiciSignIn = "flagship/voici-sign-in/v1"
    public static let tagVoiciSignInRequest = "flagship/voici-sign-in-request/v1"

    /// `.com` and the phone refuse a sentAt further than this from their clock.
    public static let sendSkewMs: Int64 = 10 * 60_000
    public static let draftMaxEnvelopeBytes = 1024 * 1024
    public static let draftMaxBodyBytes = 960 * 1024
    public static let draftMaxImageBytes = 150 * 1024
    public static let draftMaxImages = 4
    public static let stateMaxBytes = 256 * 1024

    // MARK: derivations

    static func kdf(_ ikm: [UInt8], _ info: String) -> [UInt8] {
        let k = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: [UInt8](), info: Array(info.utf8), outputByteCount: 32)
        return k.withUnsafeBytes { [UInt8]($0) }
    }

    static func needPageId(_ pageId: String) throws {
        guard VoiciPage.isPageId(pageId) else { throw CanonicalJsonError("pageId must be 16 bytes of lowercase hex") }
    }

    static func needEpoch(_ e: Int64) throws {
        guard CanonicalJson.isTime(e), e >= 1 else { throw CanonicalJsonError("inboxEpoch must be an integer >= 1") }
    }

    /// The owner's inbox X-Wing key: `seed` (32, the secret) and `publicKey` (1216).
    public static func deriveVoiciInboxKey(umk: [UInt8], pageId: String, inboxEpoch: Int64) throws -> (seed: [UInt8], publicKey: [UInt8]) {
        try needPageId(pageId)
        try needEpoch(inboxEpoch)
        let seed = kdf(umk, "\(tagVoiciInbox)|\(pageId)|\(inboxEpoch)")
        return (seed, try PqHybrid.hybridSealKeygen(seed: seed).publicKey)
    }

    /// The owner's messages signing key (Ed25519): signs replies, blocks and phone acks.
    public static func deriveVoiciOwnerSignKey(umk: [UInt8], pageId: String, inboxEpoch: Int64) throws -> (seed: [UInt8], publicKey: [UInt8]) {
        try needPageId(pageId)
        try needEpoch(inboxEpoch)
        let seed = kdf(umk, "\(tagVoiciOwnerSign)|\(pageId)|\(inboxEpoch)")
        return (seed, try CanonicalJson.ed25519PublicKey(seed: seed))
    }

    public static func deriveMessagesSecret(umk: [UInt8]) -> [UInt8] { kdf(umk, tagMessagesSecret) }

    /// The sender's pseudonym key P toward one page (Ed25519).
    public static func deriveMessagesPseudonymKey(messagesSecret: [UInt8], pageId: String) throws -> (seed: [UInt8], publicKey: [UInt8]) {
        try needPageId(pageId)
        let seed = kdf(messagesSecret, "\(tagMessagesPseudonym)|\(pageId)")
        return (seed, try CanonicalJson.ed25519PublicKey(seed: seed))
    }

    /// The sender's thread key T toward one page (X-Wing).
    public static func deriveMessagesThreadKey(messagesSecret: [UInt8], pageId: String) throws -> (seed: [UInt8], publicKey: [UInt8]) {
        try needPageId(pageId)
        let seed = kdf(messagesSecret, "\(tagMessagesThread)|\(pageId)")
        return (seed, try PqHybrid.hybridSealKeygen(seed: seed).publicKey)
    }

    public static func deriveVoiciDraftsKey(umk: [UInt8]) -> [UInt8] { kdf(umk, tagVoiciDrafts) }
    public static func deriveMessagesStateKey(umk: [UInt8]) -> [UInt8] { kdf(umk, tagMessagesState) }

    public static func voiciConv(pageId: String, pseudonymPub: String) throws -> String {
        try needPageId(pageId)
        guard CanonicalJson.isLowerHex(pseudonymPub, bytes: 32) else { throw CanonicalJsonError("pseudonym key must be 32 bytes of lowercase hex") }
        return CanonicalJson.sha256Hex("\(tagVoiciConv)|\(pageId)|\(pseudonymPub)")
    }

    // MARK: AES-256-GCM (ct || tag, like noble's gcm)

    static func gcmSeal(key: [UInt8], nonce: [UInt8], aad: String, _ pt: [UInt8]) throws -> [UInt8] {
        let box = try AES.GCM.seal(pt, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce), authenticating: Array(aad.utf8))
        return [UInt8](box.ciphertext) + [UInt8](box.tag)
    }

    static func gcmOpen(key: [UInt8], nonce: [UInt8], aad: String, _ ct: [UInt8]) throws -> [UInt8] {
        guard ct.count >= 16 else { throw CanonicalJsonError("gcm: too short") }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct[0..<(ct.count - 16)], tag: ct[(ct.count - 16)...])
        return [UInt8](try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Array(aad.utf8)))
    }

    static func random(_ n: Int) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: n)
        precondition(SecRandomCopyBytes(kSecRandomDefault, n, &b) == errSecSuccess)
        return b
    }

    // MARK: sealed body

    static func plaintextBytes(_ p: VoiciPlaintext) throws -> [UInt8] {
        if let t = VoiciText.checkVoiciText(.messageText, p.text) { throw CanonicalJsonError("voici body: text refused (\(t.rawValue))") }
        if let r = p.replyTo, !CanonicalJson.isLowerHex(r, bytes: 16) { throw CanonicalJsonError("voici body: bad replyTo") }
        return try CanonicalJson.canonicalJsonBytes(p.json)
    }

    /// Seals `plaintext` for a message (recipients [inboxPub, threadPub]) or a reply ([threadPub, inboxPub]).
    /// `rnd` only for vectors; omitted, everything is fresh randomness.
    public static func sealVoiciBody(conv: String, msgId: String, sentAt: Int64, fromPub: String, recipients: [[UInt8]],
                                     plaintext: VoiciPlaintext, randomness rnd: VoiciSealRandomness? = nil) throws -> [UInt8] {
        guard CanonicalJson.isLowerHex(msgId, bytes: 16), CanonicalJson.isLowerHex(conv, bytes: 32), CanonicalJson.isLowerHex(fromPub),
              sentAt >= 0, recipients.count == 2 else { throw CanonicalJsonError("voici body: bad ids") }
        let cek = rnd?.cek ?? random(32)
        let nonce = rnd?.nonce ?? random(12)
        guard cek.count == 32, nonce.count == 12 else { throw CanonicalJsonError("voici body: bad randomness") }
        let ct = try gcmSeal(key: cek, nonce: nonce, aad: "\(tagVoiciBody)|\(conv)|\(msgId)", try plaintextBytes(plaintext))
        let senderKeyId = CanonicalJson.sha256(try CanonicalJson.hexToBytes(fromPub))
        var wraps: [JSONValue] = []
        for (i, pub) in recipients.enumerated() {
            let eseed = (rnd.map { i < $0.eseeds.count ? $0.eseeds[i] : nil } ?? nil) ?? random(PqHybrid.sealRandomnessLen)
            let sealed = try PqHybrid.hybridSealWithRandomness(
                recipientPublicKey: pub, options: HybridSealOptions(purpose: tagVoiciCek, senderKeyId: senderKeyId, issuedAt: UInt64(sentAt)),
                context: [Array(conv.utf8), Array(msgId.utf8)], plaintext: cek, eseed: eseed)
            wraps.append(["keyId": .string(CanonicalJson.hex(PqHybrid.pqKeyId(suite: PqHybrid.suiteHybridSealV1, publicKey: pub))),
                          "sealed": .string(CanonicalJson.b64Encode(sealed))])
        }
        return try CanonicalJson.canonicalJsonBytes(["suite": .string(PqHybrid.tagHybridSealV1), "nonce": .string(CanonicalJson.hex(nonce)),
                                                     "ct": .string(CanonicalJson.b64Encode(ct)), "wraps": .array(wraps)])
    }

    /// Strict outer schema of a sealed body (before anything is decrypted): canonical JSON, exactly two wraps.
    public static func parseVoiciSealedBody(_ bodyBytes: [UInt8]) -> VoiciSealedBody? {
        guard let text = CanonicalJson.utf8Decode(bodyBytes), let v = JSONValue.parse(text), let r = v.object,
              Set(r.keys) == ["suite", "nonce", "ct", "wraps"], r["suite"]?.string == PqHybrid.tagHybridSealV1,
              CanonicalJson.isLowerHex(r["nonce"], bytes: 12), CanonicalJson.b64Decode(r["ct"]) != nil,
              let ws = r["wraps"]?.array, ws.count == 2 else { return nil }
        var wraps: [(keyId: String, sealed: String)] = []
        for w in ws {
            guard let o = w.object, Set(o.keys) == ["keyId", "sealed"], CanonicalJson.isLowerHex(o["keyId"], bytes: 32),
                  CanonicalJson.b64Decode(o["sealed"]) != nil else { return nil }
            wraps.append((o["keyId"]!.string!, o["sealed"]!.string!))
        }
        guard CanonicalJson.isCanonical(v, text) else { return nil }
        return VoiciSealedBody(nonce: r["nonce"]!.string!, ct: r["ct"]!.string!, wraps: wraps)
    }

    /// Unwraps the CEK with the recipient's X-Wing seed, decrypts, then the inner schema and the text refusals.
    /// Throws only for a recipient seed that is not an X-Wing seed.
    public static func openVoiciBody(_ bodyBytes: [UInt8], conv: String, msgId: String, recipientSeed: [UInt8]) throws -> VoiciVerdict<VoiciPlaintext, VoiciOpenRefusal> {
        guard let b = parseVoiciSealedBody(bodyBytes) else { return .refused(.malformed) }
        let myId = CanonicalJson.hex(PqHybrid.pqKeyId(suite: PqHybrid.suiteHybridSealV1, publicKey: try PqHybrid.hybridSealKeygen(seed: recipientSeed).publicKey))
        guard let w = b.wraps.first(where: { $0.keyId == myId }) else { return .refused(.noWrap) }
        let pt: [UInt8]
        do {
            let cek = try PqHybrid.hybridOpen(recipientSecretKey: recipientSeed, expectedPurpose: tagVoiciCek,
                                              context: [Array(conv.utf8), Array(msgId.utf8)], sealed: CanonicalJson.b64Decode(w.sealed)!).plaintext
            guard cek.count == 32 else { return .refused(.decryptFailed) }
            pt = try gcmOpen(key: cek, nonce: try CanonicalJson.hexToBytes(b.nonce), aad: "\(tagVoiciBody)|\(conv)|\(msgId)", CanonicalJson.b64Decode(b.ct)!)
        } catch {
            return .refused(.decryptFailed)
        }
        guard let text = CanonicalJson.utf8Decode(pt), let v = JSONValue.parse(text) else { return .refused(.innerSchema) }
        guard let r = v.object, Set(r.keys) == ["v", "text", "replyTo"], r["v"]?.isOne == true, r["text"]?.isJSString == true,
              let rt = r["replyTo"], rt.isNull || CanonicalJson.isLowerHex(rt, bytes: 16) else { return .refused(.innerSchema) }
        if let tr = VoiciText.checkVoiciText(.messageText, r["text"]) { return .refused(VoiciOpenRefusal(rawValue: tr.rawValue)!) }
        guard CanonicalJson.isCanonical(v, text) else { return .refused(.innerSchema) }
        return .ok(VoiciPlaintext(text: r["text"]!.string!, replyTo: rt.string))
    }

    // MARK: thread statement

    public static func canonicalVoiciThreadStatement(_ s: VoiciThreadStatement) throws -> [UInt8] {
        try needPageId(s.pageId)
        guard CanonicalJson.isLowerHex(s.pseudonymPub, bytes: 32), CanonicalJson.isLowerHex(s.threadPub, bytes: 1216),
              CanonicalJson.isTime(s.issuedAt) else { throw CanonicalJsonError("\(tagVoiciThreadKey): bad field") }
        return CanonicalJson.join([tagVoiciThreadKey, s.pageId, s.pseudonymPub, s.threadPub, String(s.issuedAt)])
    }

    public static func signVoiciThreadStatement(_ s: VoiciThreadStatement, pseudonymSeed: [UInt8]) throws -> String {
        try CanonicalJson.ed25519SignHex(try canonicalVoiciThreadStatement(s), seed: pseudonymSeed)
    }

    public static func parseVoiciThreadStatement(_ v: JSONValue?) -> VoiciThreadStatement? {
        guard let r = v?.object, Set(r.keys) == ["pageId", "pseudonymPub", "threadPub", "issuedAt"], let pageId = r["pageId"]?.string,
              let p = r["pseudonymPub"]?.string, let t = r["threadPub"]?.string, let at = r["issuedAt"]?.safeInt else { return nil }
        let s = VoiciThreadStatement(pageId: pageId, pseudonymPub: p, threadPub: t, issuedAt: at)
        return (try? canonicalVoiciThreadStatement(s)) != nil ? s : nil
    }

    // MARK: envelope checks

    static func outer(_ input: JSONValue, maxEnvelope: Int, maxBody: Int) -> VoiciVerdict<WebEnvelope, VoiciCheckRefusal> {
        switch input {
        case .string(let text):
            if text.utf8.count > maxEnvelope { return .refused(.tooLarge) }
        case .brokenString(let u):
            // TextEncoder writes a lone surrogate as U+FFFD; such text never parses into an envelope here.
            return String(decoding: u, as: UTF16.self).utf8.count > maxEnvelope ? .refused(.tooLarge) : .refused(.malformed)
        default:
            if CanonicalJson.jsonStringifyByteCount(input) > maxEnvelope { return .refused(.tooLarge) }
        }
        guard let e = WebEnvelope.parseWebEnvelope(input, maxBodyBytes: maxBody) else { return .refused(.malformed) }
        return .ok(e)
    }

    static func fresh(_ sentAt: Int64, _ now: Int64) -> Bool { abs(sentAt - now) <= sendSkewMs }

    /// The receiver's checks for a voici-message (§8.3, §12.1), cheapest first: size, outer schema, kind, audience,
    /// accepting, blocked / banned, revoked, rate limits, attestation, delegation, thread statement, conv, the
    /// envelope's P-256 signature by the delegated key, freshness. Message-id uniqueness and seq are the caller's.
    public static func checkVoiciMessage(_ input: JSONValue, _ ctx: VoiciMessageCheckContext) -> VoiciVerdict<(envelope: WebEnvelope, cred: VoiciMessageCred), VoiciCheckRefusal> {
        let o = outer(input, maxEnvelope: WebEnvelope.maxBytes, maxBody: WebEnvelope.maxBodyBytes)
        guard case .ok(let env) = o else { if case .refused(let c) = o { return .refused(c) }; return .refused(.malformed) }
        if env.kind != "voici-message" || env.sigAlg != .p256 { return .refused(.wrongKind) }
        if !CanonicalJson.isLowerHex(env.from, bytes: 32) || !CanonicalJson.isLowerHex(env.conv, bytes: 32) { return .refused(.malformed) }
        if parseVoiciSealedBody(CanonicalJson.b64Decode(env.bodyB64)!) == nil { return .refused(.malformed) }
        let c = env.cred
        if Set(c.keys) != ["attestation", "delegation", "delegationSig", "threadStmt", "threadSig"] { return .refused(.malformed) }
        if !CanonicalJson.same(env.audience, ctx.pageId) { return .refused(.wrongAudience) }
        if !ctx.acceptsMessages { return .refused(.notAccepting) }
        if ctx.blocked?.contains(env.from) == true { return .refused(.blocked) }
        if let dp = c["delegation"]?["delegatePub"]?.string, ctx.revoked?.contains(dp) == true { return .refused(.revoked) }
        if let limited = ctx.rateLimit?(env) { return .refused(limited) }
        guard case .ok(let att) = MessagesAttestations.checkMessagesKeyAttestation(c["attestation"], caKeys: ctx.caKeys, now: ctx.now, pseudonymPub: env.from)
        else { return .refused(.badAttestation) }
        let want = WebDelegations.Want(origin: ctx.origin, audience: ctx.pageId, principalPub: env.from, now: ctx.now, notAfter: att.expiresAt)
        guard case .ok(let del) = WebDelegations.checkWebDelegation(c["delegation"], signature: c["delegationSig"], want: want)
        else { return .refused(.badDelegation) }
        guard let ts = parseVoiciThreadStatement(c["threadStmt"]), CanonicalJson.same(ts.pageId, ctx.pageId),
              CanonicalJson.same(ts.pseudonymPub, env.from), let threadSig = c["threadSig"]?.string,
              let tsBytes = try? canonicalVoiciThreadStatement(ts), CanonicalJson.ed25519VerifyHex(threadSig, tsBytes, env.from)
        else { return .refused(.badThread) }
        guard let conv = try? voiciConv(pageId: ctx.pageId, pseudonymPub: env.from), conv == env.conv else { return .refused(.wrongConv) }
        if !WebEnvelope.verifyWebEnvelopeSignature(env, signerPub: del.delegatePub) { return .refused(.badSignature) }
        if !fresh(env.sentAt, ctx.now) { return .refused(.stale) }
        return .ok((env, VoiciMessageCred(attestation: att, delegation: del, delegationSig: c["delegationSig"]!.string!, threadStmt: ts, threadSig: threadSig)))
    }

    /// A voici-reply: kind, audience = pageId, cred exactly {pageSeq}, from = the page's ownerSignPub, conv when
    /// given, the Ed25519 signature, freshness only when `freshAt` is given.
    public static func checkVoiciReply(_ input: JSONValue, pageId: String, ownerSignPub: String, conv: String? = nil, freshAt: Int64? = nil)
        -> VoiciVerdict<(envelope: WebEnvelope, pageSeq: Int64), VoiciCheckRefusal> {
        let o = outer(input, maxEnvelope: WebEnvelope.maxBytes, maxBody: WebEnvelope.maxBodyBytes)
        guard case .ok(let env) = o else { if case .refused(let c) = o { return .refused(c) }; return .refused(.malformed) }
        if env.kind != "voici-reply" || env.sigAlg != .ed25519 { return .refused(.wrongKind) }
        guard CanonicalJson.isLowerHex(env.conv, bytes: 32), Set(env.cred.keys) == ["pageSeq"], let pageSeq = env.cred["pageSeq"]?.time, pageSeq >= 1
        else { return .refused(.malformed) }
        if parseVoiciSealedBody(CanonicalJson.b64Decode(env.bodyB64)!) == nil { return .refused(.malformed) }
        if !CanonicalJson.same(env.audience, pageId) { return .refused(.wrongAudience) }
        if let conv, !CanonicalJson.same(env.conv, conv) { return .refused(.wrongConv) }
        if !CanonicalJson.same(env.from, ownerSignPub) || !WebEnvelope.verifyWebEnvelopeSignature(env, signerPub: ownerSignPub) { return .refused(.badSignature) }
        if let at = freshAt, !fresh(env.sentAt, at) { return .refused(.stale) }
        return .ok((env, pageSeq))
    }

    /// A voici-draft from another device of the owner's account: kind, audience = username, conv "", cred exactly
    /// {grant, grantSignature}, the Ed25519 signature by `from`, then `checkGrant` (the caller's grant-chain check)
    /// and freshness when `freshAt` is given. Caps: draftMax*.
    public static func checkVoiciDraft(_ input: JSONValue, username: String, checkGrant: (JSONValue, String, String) -> Bool, freshAt: Int64? = nil)
        -> VoiciVerdict<WebEnvelope, VoiciCheckRefusal> {
        let o = outer(input, maxEnvelope: draftMaxEnvelopeBytes, maxBody: draftMaxBodyBytes)
        guard case .ok(let env) = o else { if case .refused(let c) = o { return .refused(c) }; return .refused(.malformed) }
        if env.kind != "voici-draft" || env.sigAlg != .ed25519 { return .refused(.wrongKind) }
        guard env.conv.isEmpty, CanonicalJson.isLowerHex(env.from, bytes: 32), Set(env.cred.keys) == ["grant", "grantSignature"],
              CanonicalJson.isLowerHex(env.cred["grantSignature"], bytes: 64) else { return .refused(.malformed) }
        if parseVoiciDraftBody(CanonicalJson.b64Decode(env.bodyB64)!) == nil { return .refused(.malformed) }
        if !CanonicalJson.same(env.audience, username) { return .refused(.wrongAudience) }
        if !WebEnvelope.verifyWebEnvelopeSignature(env, signerPub: env.from) { return .refused(.badSignature) }
        if !checkGrant(env.cred["grant"]!, env.cred["grantSignature"]!.string!, env.from) { return .refused(.badGrant) }
        if let at = freshAt, !fresh(env.sentAt, at) { return .refused(.stale) }
        return .ok(env)
    }
}
