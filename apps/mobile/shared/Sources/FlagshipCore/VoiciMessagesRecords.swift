import Foundation

/// voi.ci Messages records (docs/voici-and-messages.md §5.2, §6.1, §6.5, §8.2, §9.2, §10.1): the phone's delivery ack,
/// block orders, draft ops and the sealed voici-draft body, the Messages state blob, message and page reports, and
/// the "Sign in with Flagship" pipe payloads. Swift twin of the second half of packages/protocol/src/voiciMessages.ts,
/// pinned by packages/protocol/test-vectors/messages/vectors.json (`draft`, `ack`, `block`, `state`, `reports`,
/// `signIn`). Not ported: thread fetches, report-text sealing and ban / takedown requests (browser and `.com` only).
///
///   ack    flagship/voici-ack/v1|<conv or "">|<msgId>|<receivedAt>|<phoneRoutePub>
///   block  flagship/voici-block/v1|<pageId>|<Ppub>|block|unblock|<issuedAt>                 (owner messages key)
///   draft  canonicalJson({suite:"flagship/voici-draft/v1", nonce, ct}); ct = AES-256-GCM(draftsKey, nonce,
///          aad "flagship/voici-draft/v1|<username>|<opId>", canonicalJson(op))
///   state  {version, nonce, ct}; ct = AES-256-GCM(stateKey, nonce, aad "flagship/messages-state/v1|<u>|<version>")
///   report flagship/voici-report/v1|message|<pageId>|<H(canonicalJson(envelope))>|<reason>|<H(attached) or "">|<issuedAt>
///          flagship/voici-report/v1|page|<username>|<seq>|<reason>|<H(note)>|<issuedAt>
///
/// Public API: VoiciAck, VoiciBlock, VoiciDraftImage, VoiciDraftOp, MessagesState (+ Nickname, SignedInSite),
/// SealedMessagesState, VoiciMessageReport, VoiciPageReport, VoiciSignInRequest, VoiciSignInAnswer,
/// VoiciSignInRefusal, and on VoiciMessages: canonicalVoiciAck, signVoiciAck, verifyVoiciAck, canonicalVoiciBlock,
/// signVoiciBlock, verifyVoiciBlock, parseVoiciBlock, draftOpKinds, parseVoiciDraftOp, sealVoiciDraft,
/// parseVoiciDraftBody, openVoiciDraft, emptyMessagesState, parseMessagesState, mergeMessagesState,
/// sealMessagesState, openMessagesState, reportReasons, canonicalVoiciMessageReport, canonicalVoiciPageReport,
/// signVoiciMessageReport, verifyVoiciMessageReport, parseVoiciSignInRequest, checkVoiciSignInAnswer.
public struct VoiciAck: Equatable, Sendable {
    /// "" for a draft.
    public var conv: String
    public var msgId: String
    public var receivedAt: Int64
    public var phoneRoutePub: String
    public init(conv: String, msgId: String, receivedAt: Int64, phoneRoutePub: String) {
        self.conv = conv; self.msgId = msgId; self.receivedAt = receivedAt; self.phoneRoutePub = phoneRoutePub
    }
    public func json(signature: String) -> JSONValue {
        ["conv": .string(conv), "msgId": .string(msgId), "receivedAt": .int(receivedAt), "phoneRoutePub": .string(phoneRoutePub), "signature": .string(signature)]
    }
}

public struct VoiciBlock: Equatable, Sendable {
    public var pageId: String
    public var pseudonymPub: String
    /// "block" or "unblock".
    public var op: String
    public var issuedAt: Int64
    public init(pageId: String, pseudonymPub: String, op: String, issuedAt: Int64) {
        self.pageId = pageId; self.pseudonymPub = pseudonymPub; self.op = op; self.issuedAt = issuedAt
    }
    public var json: JSONValue { ["pageId": .string(pageId), "pseudonymPub": .string(pseudonymPub), "op": .string(op), "issuedAt": .int(issuedAt)] }
}

public struct VoiciDraftImage: Equatable, Sendable {
    public var sha256: String
    /// Standard base64 of the re-encoded JPEG.
    public var data: String
    public init(sha256: String, data: String) { self.sha256 = sha256; self.data = data }
    public var json: JSONValue { ["sha256": .string(sha256), "data": .string(data)] }
}

/// {v:1, opId, op, at, deviceId, post | postId | profile | accepts, images?}.
public struct VoiciDraftOp: Equatable, Sendable {
    public var opId: String
    /// "post-add", "post-edit", "post-delete", "profile" or "accept-messages".
    public var op: String
    public var at: Int64
    public var deviceId: String
    public var post: VoiciPost?
    public var postId: String?
    public var profile: VoiciProfile?
    public var accepts: Int64?
    public var images: [VoiciDraftImage]?

    public init(opId: String, op: String, at: Int64, deviceId: String, post: VoiciPost? = nil, postId: String? = nil,
                profile: VoiciProfile? = nil, accepts: Int64? = nil, images: [VoiciDraftImage]? = nil) {
        self.opId = opId; self.op = op; self.at = at; self.deviceId = deviceId; self.post = post; self.postId = postId
        self.profile = profile; self.accepts = accepts; self.images = images
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = ["v": 1, "opId": .string(opId), "op": .string(op), "at": .int(at), "deviceId": .string(deviceId)]
        if let post { o["post"] = post.json }
        if let postId { o["postId"] = .string(postId) }
        if let profile { o["profile"] = profile.json }
        if let accepts { o["accepts"] = .int(accepts) }
        if let images { o["images"] = .array(images.map(\.json)) }
        return .object(o)
    }
}

public struct MessagesState: Equatable, Sendable {
    public struct Nickname: Equatable, Sendable {
        public var name: String
        public var at: Int64
        public init(name: String, at: Int64) { self.name = name; self.at = at }
    }
    public struct SignedInSite: Equatable, Sendable {
        public var pageId: String
        public var delegatePub: String
        public var at: Int64
        public init(pageId: String, delegatePub: String, at: Int64) { self.pageId = pageId; self.delegatePub = delegatePub; self.at = at }
    }

    public var nicknames: [String: Nickname] = [:]
    public var blocks: [String] = []
    public var accepted: [String] = []
    public var archived: [String] = []
    public var readUpTo: [String: String] = [:]
    public var signedInSites: [SignedInSite] = []
    public var pendingOps: [VoiciDraftOp] = []

    public init() {}

    public var json: JSONValue {
        ["v": 1,
         "nicknames": .object(nicknames.mapValues { ["name": .string($0.name), "at": .int($0.at)] }),
         "blocks": .array(blocks.map { .string($0) }), "accepted": .array(accepted.map { .string($0) }),
         "archived": .array(archived.map { .string($0) }), "readUpTo": .object(readUpTo.mapValues { .string($0) }),
         "signedInSites": .array(signedInSites.map { ["pageId": .string($0.pageId), "delegatePub": .string($0.delegatePub), "at": .int($0.at)] }),
         "pendingOps": .array(pendingOps.map(\.json))]
    }
}

public struct SealedMessagesState: Equatable, Sendable {
    public var version: Int64
    public var nonce: String
    public var ct: String
    public var json: JSONValue { ["version": .int(version), "nonce": .string(nonce), "ct": .string(ct)] }
}

public struct VoiciMessageReport: Equatable, Sendable {
    public var pageId: String
    /// The reported envelope, as received (its canonical JSON is hashed).
    public var envelope: JSONValue
    public var reason: String
    /// Standard base64 of the sealed text, or nil.
    public var attached: String?
    public var issuedAt: Int64
    public init(pageId: String, envelope: JSONValue, reason: String, attached: String?, issuedAt: Int64) {
        self.pageId = pageId; self.envelope = envelope; self.reason = reason; self.attached = attached; self.issuedAt = issuedAt
    }
}

public struct VoiciPageReport: Equatable, Sendable {
    public var username: String
    public var seq: Int64
    public var reason: String
    public var note: String
    public var issuedAt: Int64
    public init(username: String, seq: Int64, reason: String, note: String, issuedAt: Int64) {
        self.username = username; self.seq = seq; self.reason = reason; self.note = note; self.issuedAt = issuedAt
    }
}

public struct VoiciSignInRequest: Equatable, Sendable {
    public var origin: String
    public var pageId: String
    public var username: String
    public var delegatePub: String
    public var nonce: String
    public init(origin: String, pageId: String, username: String, delegatePub: String, nonce: String) {
        self.origin = origin; self.pageId = pageId; self.username = username; self.delegatePub = delegatePub; self.nonce = nonce
    }
}

public struct VoiciSignInAnswer: Equatable, Sendable {
    public var pageId: String
    public var pseudonymPub: String
    public var cred: VoiciMessageCred
    /// T's 32-byte X-Wing seed (hex), so the browser can open replies.
    public var threadSeed: String
    public init(pageId: String, pseudonymPub: String, cred: VoiciMessageCred, threadSeed: String) {
        self.pageId = pageId; self.pseudonymPub = pseudonymPub; self.cred = cred; self.threadSeed = threadSeed
    }
    public var json: JSONValue {
        var o = cred.json
        o["kind"] = .string(VoiciMessages.tagVoiciSignIn)
        o["pageId"] = .string(pageId)
        o["pseudonymPub"] = .string(pseudonymPub)
        o["threadSeed"] = .string(threadSeed)
        return .object(o)
    }
}

public enum VoiciSignInRefusal: String, Sendable {
    case malformed, badAttestation = "bad-attestation", badDelegation = "bad-delegation", badThread = "bad-thread"
}

extension VoiciMessages {
    // MARK: phone ack

    public static func canonicalVoiciAck(_ a: VoiciAck) throws -> [UInt8] {
        guard a.conv.isEmpty || CanonicalJson.isLowerHex(a.conv, bytes: 32), CanonicalJson.isLowerHex(a.msgId, bytes: 16),
              CanonicalJson.isTime(a.receivedAt), CanonicalJson.isLowerHex(a.phoneRoutePub), !a.phoneRoutePub.isEmpty
        else { throw CanonicalJsonError("\(tagVoiciAck): bad field") }
        return CanonicalJson.join([tagVoiciAck, a.conv, a.msgId, String(a.receivedAt), a.phoneRoutePub])
    }

    /// Signature (hex) by the owner messages key (voici-message) or the admin device key (voici-draft).
    public static func signVoiciAck(_ a: VoiciAck, seed: [UInt8]) throws -> String {
        try CanonicalJson.ed25519SignHex(try canonicalVoiciAck(a), seed: seed)
    }

    /// Shape + signature by `signerPub` + it acknowledges `msgId` (and `conv` when given).
    public static func verifyVoiciAck(_ v: JSONValue?, signerPub: String, msgId: String, conv: String? = nil) -> VoiciAck? {
        guard let r = v?.object, Set(r.keys) == ["conv", "msgId", "receivedAt", "phoneRoutePub", "signature"],
              let sig = r["signature"]?.string, let c = r["conv"]?.string, let m = r["msgId"]?.string,
              let at = r["receivedAt"]?.safeInt, let p = r["phoneRoutePub"]?.string else { return nil }
        let a = VoiciAck(conv: c, msgId: m, receivedAt: at, phoneRoutePub: p)
        guard let bytes = try? canonicalVoiciAck(a) else { return nil }
        if !CanonicalJson.same(a.msgId, msgId) || (conv.map { !CanonicalJson.same(a.conv, $0) } ?? false) { return nil }
        return CanonicalJson.ed25519VerifyHex(sig, bytes, signerPub) ? a : nil
    }

    // MARK: block

    public static func canonicalVoiciBlock(_ b: VoiciBlock) throws -> [UInt8] {
        try needPageId(b.pageId)
        guard CanonicalJson.isLowerHex(b.pseudonymPub, bytes: 32), b.op == "block" || b.op == "unblock", CanonicalJson.isTime(b.issuedAt)
        else { throw CanonicalJsonError("\(tagVoiciBlock): bad field") }
        return CanonicalJson.join([tagVoiciBlock, b.pageId, b.pseudonymPub, b.op, String(b.issuedAt)])
    }

    public static func signVoiciBlock(_ b: VoiciBlock, ownerSignSeed: [UInt8]) throws -> String {
        try CanonicalJson.ed25519SignHex(try canonicalVoiciBlock(b), seed: ownerSignSeed)
    }

    public static func verifyVoiciBlock(_ b: VoiciBlock, signature: String, ownerSignPub: String) -> Bool {
        guard let bytes = try? canonicalVoiciBlock(b) else { return false }
        return CanonicalJson.ed25519VerifyHex(signature, bytes, ownerSignPub)
    }

    public static func parseVoiciBlock(_ v: JSONValue?) -> VoiciBlock? {
        guard let r = v?.object, Set(r.keys) == ["pageId", "pseudonymPub", "op", "issuedAt"], let pageId = r["pageId"]?.string,
              let p = r["pseudonymPub"]?.string, let op = r["op"]?.string, let at = r["issuedAt"]?.safeInt else { return nil }
        let b = VoiciBlock(pageId: pageId, pseudonymPub: p, op: op, issuedAt: at)
        return (try? canonicalVoiciBlock(b)) != nil ? b : nil
    }

    // MARK: draft ops (§5.2)

    public static let draftOpKinds = ["post-add", "post-edit", "post-delete", "profile", "accept-messages"]
    static let opField = ["post-add": "post", "post-edit": "post", "post-delete": "postId", "profile": "profile", "accept-messages": "accepts"]

    static func isDeviceId(_ s: String) -> Bool {
        let u = s.utf8
        return (1...64).contains(u.count) && u.allSatisfy { (0x41...0x5a).contains($0) || (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2d }
    }

    /// Strict schema of a draft op; nil when malformed.
    public static func parseVoiciDraftOp(_ v: JSONValue?) -> VoiciDraftOp? {
        guard let r = v?.object, r["v"]?.isOne == true, CanonicalJson.isLowerHex(r["opId"], bytes: 16), let at = r["at"]?.time,
              let op = r["op"]?.string, let field = opField[op], draftOpKinds.contains(op),
              let deviceId = r["deviceId"]?.string, isDeviceId(deviceId) else { return nil }
        let required: Set<String> = ["v", "opId", "op", "at", "deviceId", field]
        guard required.isSubset(of: Set(r.keys)), Set(r.keys).isSubset(of: required.union(["images"])) else { return nil }
        var out = VoiciDraftOp(opId: r["opId"]!.string!, op: op, at: at, deviceId: deviceId)
        switch field {
        case "post":
            guard let p = VoiciPage.parseVoiciPost(r["post"]) else { return nil }
            out.post = p
        case "postId":
            guard CanonicalJson.isLowerHex(r["postId"], bytes: 16) else { return nil }
            out.postId = r["postId"]!.string!
        case "profile":
            guard let p = VoiciPage.parseVoiciProfile(r["profile"]) else { return nil }
            out.profile = p
        default:
            guard let a = r["accepts"]?.number, a == 0 || a == 1 else { return nil }
            out.accepts = Int64(a)
        }
        if let ims = r["images"] {
            guard let arr = ims.array, arr.count <= draftMaxImages else { return nil }
            var imgs: [VoiciDraftImage] = []
            for im in arr {
                guard let o = im.object, Set(o.keys) == ["sha256", "data"], CanonicalJson.isLowerHex(o["sha256"], bytes: 32),
                      let bytes = CanonicalJson.b64Decode(o["data"]), bytes.count <= draftMaxImageBytes,
                      CanonicalJson.sha256Hex(bytes) == o["sha256"]!.string!, VoiciPage.isVoiciJpeg(bytes) else { return nil }
                imgs.append(VoiciDraftImage(sha256: o["sha256"]!.string!, data: o["data"]!.string!))
            }
            out.images = imgs
        }
        return out
    }

    /// The voici-draft body; `nonce` only for vectors (fresh when omitted).
    public static func sealVoiciDraft(draftsKey: [UInt8], username: String, op: VoiciDraftOp, nonce: [UInt8]? = nil) throws -> [UInt8] {
        let n = nonce ?? random(12)
        guard MessagesAttestations.isUsername(username), n.count == 12 else { throw CanonicalJsonError("\(tagVoiciDraft): bad input") }
        guard parseVoiciDraftOp(op.json) != nil else { throw CanonicalJsonError("\(tagVoiciDraft): malformed op") }
        let ct = try gcmSeal(key: draftsKey, nonce: n, aad: "\(tagVoiciDraft)|\(username)|\(op.opId)", try CanonicalJson.canonicalJsonBytes(op.json))
        return try CanonicalJson.canonicalJsonBytes(["suite": .string(tagVoiciDraft), "nonce": .string(CanonicalJson.hex(n)), "ct": .string(CanonicalJson.b64Encode(ct))])
    }

    public static func parseVoiciDraftBody(_ bodyBytes: [UInt8]) -> (nonce: String, ct: String)? {
        guard let text = CanonicalJson.utf8Decode(bodyBytes), let v = JSONValue.parse(text), let r = v.object,
              Set(r.keys) == ["suite", "nonce", "ct"], r["suite"]?.string == tagVoiciDraft, CanonicalJson.isLowerHex(r["nonce"], bytes: 12),
              CanonicalJson.b64Decode(r["ct"]) != nil, CanonicalJson.isCanonical(v, text) else { return nil }
        return (r["nonce"]!.string!, r["ct"]!.string!)
    }

    /// Opens a draft body; the op's opId must equal the envelope's msgId (the AEAD binds both).
    public static func openVoiciDraft(draftsKey: [UInt8], username: String, opId: String, bodyBytes: [UInt8]) -> VoiciDraftOp? {
        guard let b = parseVoiciDraftBody(bodyBytes),
              let pt = try? gcmOpen(key: draftsKey, nonce: CanonicalJson.hexToBytes(b.nonce), aad: "\(tagVoiciDraft)|\(username)|\(opId)", CanonicalJson.b64Decode(b.ct)!),
              let op = parseVoiciDraftOp(JSONValue.parse(utf8: pt)), op.opId == opId else { return nil }
        return op
    }

    // MARK: Messages state blob (§10.1)

    public static func emptyMessagesState() -> MessagesState { MessagesState() }

    public static func parseMessagesState(_ v: JSONValue?) -> MessagesState? {
        guard let r = v?.object, r["v"]?.isOne == true,
              Set(r.keys) == ["v", "nicknames", "blocks", "accepted", "archived", "readUpTo", "signedInSites", "pendingOps"],
              let nicks = r["nicknames"]?.object, let reads = r["readUpTo"]?.object else { return nil }
        var s = MessagesState()
        for (k, n) in nicks {
            guard CanonicalJson.isLowerHex(k, bytes: 32), let o = n.object, Set(o.keys) == ["name", "at"],
                  VoiciText.checkVoiciText(.nickname, o["name"]) == nil, let at = o["at"]?.time else { return nil }
            s.nicknames[k] = MessagesState.Nickname(name: o["name"]!.string!, at: at)
        }
        func list(_ x: JSONValue?, _ bytes: Int) -> [String]? {
            guard let a = x?.array, a.allSatisfy({ CanonicalJson.isLowerHex($0, bytes: bytes) }) else { return nil }
            return a.map { $0.string! }
        }
        guard let blocks = list(r["blocks"], 32), let accepted = list(r["accepted"], 32), let archived = list(r["archived"], 32) else { return nil }
        s.blocks = blocks; s.accepted = accepted; s.archived = archived
        for (k, m) in reads {
            guard CanonicalJson.isLowerHex(k, bytes: 32), CanonicalJson.isLowerHex(m, bytes: 16) else { return nil }
            s.readUpTo[k] = m.string!
        }
        guard let sites = r["signedInSites"]?.array, let ops = r["pendingOps"]?.array else { return nil }
        for x in sites {
            guard let o = x.object, Set(o.keys) == ["pageId", "delegatePub", "at"], let p = o["pageId"]?.string, VoiciPage.isPageId(p),
                  CanonicalJson.isLowerHex(o["delegatePub"], bytes: 65), let at = o["at"]?.time else { return nil }
            s.signedInSites.append(MessagesState.SignedInSite(pageId: p, delegatePub: o["delegatePub"]!.string!, at: at))
        }
        for o in ops {
            guard let p = parseVoiciDraftOp(o) else { return nil }
            s.pendingOps.append(p)
        }
        return s
    }

    static func uniqSorted(_ a: [String]) -> [String] {
        var seen = Set<[UInt16]>()
        var out: [String] = []
        for s in a where seen.insert(Array(s.utf16)).inserted { out.append(s) }
        return out.sorted(by: CanonicalJson.utf16Less)
    }

    /// The compare-and-set merge (§10.1): sets are unions, the newer nickname wins (ties: local), readUpTo keeps the
    /// local entry, signed-in sites union by delegatePub (newer `at`), pending ops union by opId; lists sorted.
    public static func mergeMessagesState(local: MessagesState, remote: MessagesState) -> MessagesState {
        var out = MessagesState()
        out.nicknames = remote.nicknames
        for (k, n) in local.nicknames where out.nicknames[k] == nil || n.at >= out.nicknames[k]!.at { out.nicknames[k] = n }
        var sites: [String: MessagesState.SignedInSite] = [:]
        for s in remote.signedInSites + local.signedInSites where sites[s.delegatePub] == nil || s.at >= sites[s.delegatePub]!.at {
            sites[s.delegatePub] = s
        }
        var ops: [String: VoiciDraftOp] = [:]
        for o in remote.pendingOps + local.pendingOps { ops[o.opId] = o }
        out.blocks = uniqSorted(local.blocks + remote.blocks)
        out.accepted = uniqSorted(local.accepted + remote.accepted)
        out.archived = uniqSorted(local.archived + remote.archived)
        out.readUpTo = remote.readUpTo.merging(local.readUpTo) { _, l in l }
        out.signedInSites = sites.values.sorted { CanonicalJson.utf16Less($0.delegatePub, $1.delegatePub) }
        out.pendingOps = ops.values.sorted { CanonicalJson.utf16Less($0.opId, $1.opId) }
        return out
    }

    /// `nonce` only for vectors (fresh when omitted).
    public static func sealMessagesState(stateKey: [UInt8], username: String, version: Int64, state: MessagesState, nonce: [UInt8]? = nil) throws -> SealedMessagesState {
        let n = nonce ?? random(12)
        guard MessagesAttestations.isUsername(username), CanonicalJson.isTime(version), version >= 1, n.count == 12,
              parseMessagesState(state.json) != nil else { throw CanonicalJsonError("\(tagMessagesState): bad input") }
        let pt = try CanonicalJson.canonicalJsonBytes(state.json)
        if pt.count > stateMaxBytes { throw CanonicalJsonError("\(tagMessagesState): too large") }
        let ct = try gcmSeal(key: stateKey, nonce: n, aad: "\(tagMessagesState)|\(username)|\(version)", pt)
        return SealedMessagesState(version: version, nonce: CanonicalJson.hex(n), ct: CanonicalJson.b64Encode(ct))
    }

    public static func openMessagesState(stateKey: [UInt8], username: String, blob: JSONValue?) -> MessagesState? {
        guard let r = blob?.object, Set(r.keys) == ["version", "nonce", "ct"], let version = r["version"]?.time,
              CanonicalJson.isLowerHex(r["nonce"], bytes: 12), let ct = CanonicalJson.b64Decode(r["ct"]), ct.count <= stateMaxBytes + 16,
              let pt = try? gcmOpen(key: stateKey, nonce: CanonicalJson.hexToBytes(r["nonce"]!.string!), aad: "\(tagMessagesState)|\(username)|\(version)", ct)
        else { return nil }
        return parseMessagesState(JSONValue.parse(utf8: pt))
    }

    // MARK: reports (§9.2)

    public static let reportReasons = ["spam", "harassment", "impersonation", "illegal", "other"]

    public static func canonicalVoiciMessageReport(_ r: VoiciMessageReport) throws -> [UInt8] {
        guard reportReasons.contains(r.reason), CanonicalJson.isTime(r.issuedAt) else { throw CanonicalJsonError("\(tagVoiciReport): bad field") }
        try needPageId(r.pageId)
        var att = ""
        if let a = r.attached {
            guard let bytes = CanonicalJson.b64Decode(a) else { throw CanonicalJsonError("\(tagVoiciReport): bad attached") }
            att = CanonicalJson.sha256Hex(bytes)
        }
        return CanonicalJson.join([tagVoiciReport, "message", r.pageId, CanonicalJson.sha256Hex(try CanonicalJson.canonicalJsonBytes(r.envelope)),
                                   r.reason, att, String(r.issuedAt)])
    }

    public static func canonicalVoiciPageReport(_ r: VoiciPageReport) throws -> [UInt8] {
        guard reportReasons.contains(r.reason), CanonicalJson.isTime(r.issuedAt), MessagesAttestations.isUsername(r.username),
              CanonicalJson.isTime(r.seq), r.seq >= 1, VoiciText.checkVoiciText(.reportNote, r.note) == nil
        else { throw CanonicalJsonError("\(tagVoiciReport): bad field") }
        return CanonicalJson.join([tagVoiciReport, "page", r.username, String(r.seq), r.reason, CanonicalJson.sha256Hex(r.note), String(r.issuedAt)])
    }

    public static func signVoiciMessageReport(_ r: VoiciMessageReport, ownerSignSeed: [UInt8]) throws -> String {
        try CanonicalJson.ed25519SignHex(try canonicalVoiciMessageReport(r), seed: ownerSignSeed)
    }

    public static func verifyVoiciMessageReport(_ r: VoiciMessageReport, signature: String, ownerSignPub: String) -> Bool {
        guard let bytes = try? canonicalVoiciMessageReport(r) else { return false }
        return CanonicalJson.ed25519VerifyHex(signature, bytes, ownerSignPub)
    }

    // MARK: Sign in with Flagship (§6.1, §6.5)

    public static func parseVoiciSignInRequest(_ v: JSONValue?) -> VoiciSignInRequest? {
        guard let r = v?.object, Set(r.keys) == ["kind", "origin", "pageId", "username", "delegatePub", "nonce"],
              r["kind"]?.string == tagVoiciSignInRequest, let origin = r["origin"]?.string, origin.hasPrefix("https://"),
              (1...253).contains(origin.utf8.count - 8),
              origin.utf8.dropFirst(8).allSatisfy({ (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2e || $0 == 0x2d }),
              let pageId = r["pageId"]?.string, VoiciPage.isPageId(pageId), let username = r["username"]?.string,
              MessagesAttestations.isUsername(username), CanonicalJson.isLowerHex(r["delegatePub"], bytes: 65),
              r["delegatePub"]!.string!.hasPrefix("04"), CanonicalJson.isLowerHex(r["nonce"], bytes: 16) else { return nil }
        return VoiciSignInRequest(origin: origin, pageId: pageId, username: username, delegatePub: r["delegatePub"]!.string!, nonce: r["nonce"]!.string!)
    }

    /// The browser's check of the answer: everything it will put in each message's cred must already verify.
    public static func checkVoiciSignInAnswer(_ v: JSONValue?, request: VoiciSignInRequest, caKeys: [String], now: Int64)
        -> VoiciVerdict<VoiciSignInAnswer, VoiciSignInRefusal> {
        let keys: Set<String> = ["kind", "pageId", "pseudonymPub", "attestation", "delegation", "delegationSig", "threadStmt", "threadSig", "threadSeed"]
        guard let r = v?.object, Set(r.keys) == keys, r["kind"]?.string == tagVoiciSignIn, let pageId = r["pageId"]?.string,
              CanonicalJson.same(pageId, request.pageId) else { return .refused(.malformed) }
        guard CanonicalJson.isLowerHex(r["pseudonymPub"], bytes: 32), CanonicalJson.isLowerHex(r["threadSeed"], bytes: 32),
              let p = r["pseudonymPub"]?.string, let seed = r["threadSeed"]?.string, let threadSig = r["threadSig"]?.string else { return .refused(.malformed) }
        guard case .ok(let att) = MessagesAttestations.checkMessagesKeyAttestation(r["attestation"], caKeys: caKeys, now: now, pseudonymPub: p)
        else { return .refused(.badAttestation) }
        let want = WebDelegations.Want(origin: request.origin, audience: request.pageId, principalPub: p, now: now, notAfter: att.expiresAt)
        guard case .ok(let del) = WebDelegations.checkWebDelegation(r["delegation"], signature: r["delegationSig"], want: want),
              CanonicalJson.same(del.delegatePub, request.delegatePub), CanonicalJson.same(del.nonce, request.nonce) else { return .refused(.badDelegation) }
        guard let ts = parseVoiciThreadStatement(r["threadStmt"]), CanonicalJson.same(ts.pageId, request.pageId), CanonicalJson.same(ts.pseudonymPub, p),
              let tsBytes = try? canonicalVoiciThreadStatement(ts), CanonicalJson.ed25519VerifyHex(threadSig, tsBytes, p),
              let tpub = try? PqHybrid.hybridSealKeygen(seed: CanonicalJson.hexToBytes(seed)).publicKey,
              CanonicalJson.hex(tpub) == ts.threadPub else { return .refused(.badThread) }
        let cred = VoiciMessageCred(attestation: att, delegation: del, delegationSig: r["delegationSig"]!.string!, threadStmt: ts, threadSig: threadSig)
        return .ok(VoiciSignInAnswer(pageId: pageId, pseudonymPub: p, cred: cred, threadSeed: seed))
    }
}
