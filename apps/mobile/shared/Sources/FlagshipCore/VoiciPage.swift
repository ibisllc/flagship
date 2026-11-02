import Foundation

/// voi.ci pages (docs/voici-and-messages.md §2, §3, §5): the signed index of content-addressed pieces, the piece
/// schemas and caps, anti-rollback, the piece-upload signature, the one-namespace key, post chunking and the
/// two-admin-device merge. Swift twin of packages/protocol/src/voiciPage.ts, pinned by
/// packages/protocol/test-vectors/voici/vectors.json.
///
///   flagship/voici-page/v1|<username>|<pageId>|<seq>|<issuedAt>|<acceptsMessages 0|1>|<inboxEpoch>|<inboxPub>
///     |<ownerSignPub>|<pieces "role:sha256:size" sorted, ","-joined>|<signerKind admin-root|irk>|<signerPub>
///   flagship/voici-piece-upload/v1|<u>|<pageId>|<sha256>|<size>|<issuedAt>
/// Both Ed25519 by the account's sensitive key (admin root; the IRK only when the account pins none).
///
/// Public API: VoiciProfile, VoiciProfileLink, VoiciCard, VoiciPostLink, VoiciPost, VoiciChunk, VoiciPieceRef,
/// VoiciPageIndex (+ Refusal), VoiciPieceUpload, VoiciPageState (all with `json`), and the VoiciPage namespace:
/// tagVoiciPage, tagVoiciPieceUpload, the caps, themes, voiciNamespaceKey, isVoiciJpeg, voiciJpegHasMetadata,
/// parseVoiciProfile, parseVoiciProfilePiece, parseVoiciPost, parseVoiciChunkPiece, voiciCardRole,
/// canonicalVoiciPageIndex, signVoiciPageIndex, parseVoiciPageIndex, checkVoiciPageIndex, checkVoiciPublish,
/// voiciPieceRefsOk, canonicalVoiciPieceUpload, signVoiciPieceUpload, verifyVoiciPieceUpload, chunkVoiciPosts,
/// mergeVoiciPage.
public struct VoiciProfileLink: Equatable, Sendable {
    public var url: String
    public var label: String
    public var site: String?
    public init(url: String, label: String, site: String?) { self.url = url; self.label = label; self.site = site }
    public var json: JSONValue { ["url": .string(url), "label": .string(label), "site": .optString(site)] }
}

public struct VoiciProfile: Equatable, Sendable {
    public var displayName: String
    public var bio: String
    public var avatar: String?
    public var theme: String
    public var links: [VoiciProfileLink]
    public init(displayName: String, bio: String, avatar: String?, theme: String, links: [VoiciProfileLink]) {
        self.displayName = displayName; self.bio = bio; self.avatar = avatar; self.theme = theme; self.links = links
    }
    public var json: JSONValue {
        ["v": 1, "displayName": .string(displayName), "bio": .string(bio), "avatar": .optString(avatar), "theme": .string(theme),
         "links": .array(links.map(\.json))]
    }
}

public struct VoiciCard: Equatable, Sendable {
    public var title: String
    public var site: String
    public var description: String
    public var image: String?
    public init(title: String, site: String, description: String, image: String?) {
        self.title = title; self.site = site; self.description = description; self.image = image
    }
    public var json: JSONValue { ["title": .string(title), "site": .string(site), "description": .string(description), "image": .optString(image)] }
}

public struct VoiciPostLink: Equatable, Sendable {
    public var url: String
    public var card: VoiciCard?
    public init(url: String, card: VoiciCard?) { self.url = url; self.card = card }
    public var json: JSONValue { ["url": .string(url), "card": card?.json ?? .null] }
}

public struct VoiciPost: Equatable, Sendable {
    public var id: String
    public var createdAt: Int64
    public var editedAt: Int64?
    public var text: String
    public var links: [VoiciPostLink]
    public init(id: String, createdAt: Int64, editedAt: Int64?, text: String, links: [VoiciPostLink]) {
        self.id = id; self.createdAt = createdAt; self.editedAt = editedAt; self.text = text; self.links = links
    }
    public var json: JSONValue {
        ["id": .string(id), "createdAt": .int(createdAt), "editedAt": .optInt(editedAt), "text": .string(text), "links": .array(links.map(\.json))]
    }
}

public struct VoiciChunk: Equatable, Sendable {
    public var chunk: Int64
    public var posts: [VoiciPost]
    public init(chunk: Int64, posts: [VoiciPost]) { self.chunk = chunk; self.posts = posts }
    public var json: JSONValue { ["v": 1, "chunk": .int(chunk), "posts": .array(posts.map(\.json))] }
}

public struct VoiciPieceRef: Equatable, Sendable {
    public var role: String
    public var sha256: String
    public var size: Int64
    public init(role: String, sha256: String, size: Int64) { self.role = role; self.sha256 = sha256; self.size = size }
    public var json: JSONValue { ["role": .string(role), "sha256": .string(sha256), "size": .int(size)] }
    var key: String { "\(role):\(sha256):\(size)" }
}

public struct VoiciPageIndex: Equatable, Sendable {
    public enum Refusal: String, Sendable {
        case malformed, wrongUsername = "wrong-username", notSensitiveKey = "not-sensitive-key", badSignature = "bad-signature"
        case rolledBack = "rolled-back", stale, seqConflict = "seq-conflict", wrongPage = "wrong-page"
    }

    public var username: String
    public var pageId: String
    public var seq: Int64
    public var issuedAt: Int64
    /// 0 or 1.
    public var acceptsMessages: Int64
    public var inboxEpoch: Int64
    public var inboxPub: String
    public var ownerSignPub: String
    public var pieces: [VoiciPieceRef]
    /// "admin-root" or "irk".
    public var signerKind: String
    /// Filled by `signVoiciPageIndex`.
    public var signerPub: String
    public var signature: String

    public init(username: String, pageId: String, seq: Int64, issuedAt: Int64, acceptsMessages: Int64, inboxEpoch: Int64,
                inboxPub: String, ownerSignPub: String, pieces: [VoiciPieceRef], signerKind: String, signerPub: String = "", signature: String = "") {
        self.username = username; self.pageId = pageId; self.seq = seq; self.issuedAt = issuedAt; self.acceptsMessages = acceptsMessages
        self.inboxEpoch = inboxEpoch; self.inboxPub = inboxPub; self.ownerSignPub = ownerSignPub; self.pieces = pieces
        self.signerKind = signerKind; self.signerPub = signerPub; self.signature = signature
    }

    /// The signed envelope.
    public var json: JSONValue {
        ["kind": "VoiciPage", "version": 1, "username": .string(username), "pageId": .string(pageId), "seq": .int(seq),
         "issuedAt": .int(issuedAt), "acceptsMessages": .int(acceptsMessages), "inboxEpoch": .int(inboxEpoch),
         "inboxPub": .string(inboxPub), "ownerSignPub": .string(ownerSignPub), "pieces": .array(pieces.map(\.json)),
         "signerKind": .string(signerKind), "signerPub": .string(signerPub), "signature": .string(signature)]
    }
}

public struct VoiciPieceUpload: Equatable, Sendable {
    public var username: String
    public var pageId: String
    public var sha256: String
    public var size: Int64
    public var issuedAt: Int64
    public init(username: String, pageId: String, sha256: String, size: Int64, issuedAt: Int64) {
        self.username = username; self.pageId = pageId; self.sha256 = sha256; self.size = size; self.issuedAt = issuedAt
    }
}

public struct VoiciPageState: Equatable, Sendable {
    public var profile: VoiciProfile
    /// 0 or 1.
    public var acceptsMessages: Int64
    /// Chunk n holds posts in creation order; chunk 0 the oldest.
    public var chunks: [[VoiciPost]]
    /// The published index's issuedAt (0 for a page never published).
    public var issuedAt: Int64
    public init(profile: VoiciProfile, acceptsMessages: Int64, chunks: [[VoiciPost]], issuedAt: Int64) {
        self.profile = profile; self.acceptsMessages = acceptsMessages; self.chunks = chunks; self.issuedAt = issuedAt
    }
    public var json: JSONValue {
        ["profile": profile.json, "acceptsMessages": .int(acceptsMessages), "chunks": .array(chunks.map { .array($0.map(\.json)) }),
         "issuedAt": .int(issuedAt)]
    }
}

public enum VoiciPage {
    public static let tagVoiciPage = "flagship/voici-page/v1"
    public static let tagVoiciPieceUpload = "flagship/voici-piece-upload/v1"
    public static let profileMaxBytes = 16 * 1024
    public static let chunkMaxBytes = 256 * 1024
    public static let chunkMaxPosts = 20
    public static let avatarMaxBytes = 150 * 1024
    public static let cardImageMaxBytes = 40 * 1024
    public static let indexMaxBytes = 300 * 1024
    public static let indexMaxPieces = 2000
    public static let profileMaxLinks = 12
    public static let postMaxLinks = 3
    /// issuedAt must be within this of `.com`'s clock at upload / publish.
    public static let indexSkewMs: Int64 = 10 * 60_000
    public static let themes = ["classic", "ink", "sea"]

    static func isPageId(_ s: String) -> Bool { CanonicalJson.isLowerHex(s, bytes: 16) }
    static func isUsername(_ s: String) -> Bool { MessagesAttestations.isUsername(s) }

    /// One namespace with custom link names and codes (§4.1): lowercase, hyphens removed.
    public static func voiciNamespaceKey(_ name: String) -> String { VoiciName.key(name) }

    public static func isVoiciJpeg(_ b: [UInt8]) -> Bool { b.count >= 4 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff }

    /// True when a JPEG carries an APP1 (EXIF/XMP) or APP2 (ICC) segment before its scan.
    public static func voiciJpegHasMetadata(_ b: [UInt8]) -> Bool {
        guard isVoiciJpeg(b) else { return false }
        var i = 2
        while i + 4 <= b.count, b[i] == 0xff {
            let m = b[i + 1]
            if m == 0xda || m == 0xd9 { return false }
            if m == 0xe1 || m == 0xe2 { return true }
            i += 2 + (Int(b[i + 2]) << 8 | Int(b[i + 3]))
        }
        return false
    }

    static func exactKeys(_ r: [String: JSONValue], _ keys: Set<String>) -> Bool { Set(r.keys) == keys }

    static func parseJsonPiece(_ bytes: [UInt8], max: Int) -> [String: JSONValue]? {
        guard bytes.count <= max, let text = CanonicalJson.utf8Decode(bytes), let v = JSONValue.parse(text),
              let o = v.object, CanonicalJson.isCanonical(v, text) else { return nil }
        return o
    }

    static func optHex32(_ v: JSONValue?) -> String?? {
        guard let v else { return nil }
        if v.isNull { return .some(nil) }
        return CanonicalJson.isLowerHex(v, bytes: 32) ? .some(v.string) : nil
    }

    public static func parseVoiciProfile(_ v: JSONValue?) -> VoiciProfile? {
        guard let r = v?.object, exactKeys(r, ["v", "displayName", "bio", "avatar", "theme", "links"]), r["v"]?.isOne == true,
              VoiciText.checkVoiciText(.displayName, r["displayName"]) == nil, VoiciText.checkVoiciText(.bio, r["bio"]) == nil,
              let avatar = optHex32(r["avatar"]), let theme = r["theme"]?.string, themes.contains(theme),
              let links = r["links"]?.array, links.count <= profileMaxLinks else { return nil }
        var out: [VoiciProfileLink] = []
        var mail = 0
        for l in links {
            guard let o = l.object, exactKeys(o, ["url", "label", "site"]), VoiciText.checkVoiciLinkUrl(o["url"], allowMailto: true) == nil,
                  VoiciText.checkVoiciText(.linkLabel, o["label"]) == nil, let url = o["url"]?.string, let label = o["label"]?.string else { return nil }
            if url.hasPrefix("mailto:") { mail += 1; if mail > 1 { return nil } }
            var site: String?
            if let s = o["site"], !s.isNull {
                guard let id = s.string, VoiciText.siteIds.contains(id) else { return nil }
                site = id
            }
            out.append(VoiciProfileLink(url: url, label: label, site: site))
        }
        return VoiciProfile(displayName: r["displayName"]!.string!, bio: r["bio"]!.string!, avatar: avatar, theme: theme, links: out)
    }

    /// A profile piece's bytes: size, canonical JSON, schema.
    public static func parseVoiciProfilePiece(_ bytes: [UInt8]) -> VoiciProfile? {
        parseJsonPiece(bytes, max: profileMaxBytes).flatMap { parseVoiciProfile(.object($0)) }
    }

    static func parseCard(_ v: JSONValue) -> VoiciCard? {
        guard let r = v.object, exactKeys(r, ["title", "site", "description", "image"]),
              VoiciText.checkVoiciText(.cardTitle, r["title"]) == nil, VoiciText.checkVoiciText(.cardSite, r["site"]) == nil,
              VoiciText.checkVoiciText(.cardDescription, r["description"]) == nil, let image = optHex32(r["image"]) else { return nil }
        return VoiciCard(title: r["title"]!.string!, site: r["site"]!.string!, description: r["description"]!.string!, image: image)
    }

    public static func parseVoiciPost(_ v: JSONValue?) -> VoiciPost? {
        guard let r = v?.object, exactKeys(r, ["id", "createdAt", "editedAt", "text", "links"]),
              CanonicalJson.isLowerHex(r["id"], bytes: 16), let id = r["id"]?.string, let createdAt = r["createdAt"]?.time,
              let ed = r["editedAt"], ed.isNull || ed.time != nil, VoiciText.checkVoiciText(.postText, r["text"]) == nil,
              let links = r["links"]?.array, links.count <= postMaxLinks else { return nil }
        var out: [VoiciPostLink] = []
        for l in links {
            guard let o = l.object, exactKeys(o, ["url", "card"]), VoiciText.checkVoiciLinkUrl(o["url"]) == nil,
                  let url = o["url"]?.string, let c = o["card"] else { return nil }
            if c.isNull { out.append(VoiciPostLink(url: url, card: nil)); continue }
            guard let card = parseCard(c) else { return nil }
            out.append(VoiciPostLink(url: url, card: card))
        }
        return VoiciPost(id: id, createdAt: createdAt, editedAt: ed.time, text: r["text"]!.string!, links: out)
    }

    /// A chunk piece's bytes; `n` is the chunk number its role names. Post ids are unique in the chunk.
    public static func parseVoiciChunkPiece(_ bytes: [UInt8], n: Int64) -> VoiciChunk? {
        guard let r = parseJsonPiece(bytes, max: chunkMaxBytes), exactKeys(r, ["v", "chunk", "posts"]), r["v"]?.isOne == true,
              r["chunk"]?.number == Double(n), let posts = r["posts"]?.array, posts.count <= chunkMaxPosts else { return nil }
        var out: [VoiciPost] = []
        var ids = Set<String>()
        for p in posts {
            guard let q = parsePostChecked(p), !ids.contains(q.id) else { return nil }
            ids.insert(q.id)
            out.append(q)
        }
        return VoiciChunk(chunk: n, posts: out)
    }

    static func parsePostChecked(_ v: JSONValue) -> VoiciPost? { parseVoiciPost(v) }

    public static func voiciCardRole(_ sha256: String) -> String { "card-" + String(sha256.prefix(16)) }

    // MARK: the index

    /// `^(profile|avatar|chunk-(0|[1-9][0-9]{0,5})|card-[0-9a-f]{16})$`
    static func isRole(_ r: String) -> Bool {
        if r == "profile" || r == "avatar" { return true }
        if r.hasPrefix("chunk-") {
            let d = Array(r.utf8.dropFirst(6))
            guard (1...6).contains(d.count), d.allSatisfy({ (0x30...0x39).contains($0) }) else { return false }
            return d.count == 1 || d[0] != 0x30
        }
        if r.hasPrefix("card-") { return CanonicalJson.isLowerHex(String(r.dropFirst(5)), bytes: 8) }
        return false
    }

    static func piecesProblem(_ pieces: [VoiciPieceRef]) -> String? {
        if pieces.count > indexMaxPieces { return "pieces" }
        var roles = Set<String>()
        var chunks = 0
        for p in pieces {
            if !isRole(p.role) || !CanonicalJson.isLowerHex(p.sha256, bytes: 32) || !CanonicalJson.isTime(p.size) || p.size < 1 { return "piece field" }
            if roles.contains(p.role) { return "duplicate role" }
            roles.insert(p.role)
            if p.role.hasPrefix("card-") && p.role != voiciCardRole(p.sha256) { return "card role" }
            if p.role.hasPrefix("chunk-") { chunks += 1 }
            let cap = p.role == "profile" ? profileMaxBytes : p.role == "avatar" ? avatarMaxBytes : p.role.hasPrefix("card-") ? cardImageMaxBytes : chunkMaxBytes
            if p.size > Int64(cap) { return "piece size" }
        }
        if !roles.contains("profile") { return "no profile" }
        for i in 0..<chunks where !roles.contains("chunk-\(i)") { return "chunks not contiguous" }
        let keys = pieces.map(\.key)
        for i in keys.indices.dropFirst() where !CanonicalJson.utf16Less(keys[i - 1], keys[i]) { return "pieces not sorted" }
        return nil
    }

    public static func canonicalVoiciPageIndex(_ b: VoiciPageIndex) throws -> [UInt8] {
        func bad(_ f: String) -> CanonicalJsonError { CanonicalJsonError("\(tagVoiciPage): bad \(f)") }
        guard isUsername(b.username) else { throw bad("username") }
        guard isPageId(b.pageId) else { throw bad("pageId") }
        guard CanonicalJson.isTime(b.seq), b.seq >= 1, CanonicalJson.isTime(b.issuedAt) else { throw bad("seq/issuedAt") }
        guard b.acceptsMessages == 0 || b.acceptsMessages == 1 else { throw bad("acceptsMessages") }
        guard CanonicalJson.isTime(b.inboxEpoch), b.inboxEpoch >= 1 else { throw bad("inboxEpoch") }
        guard CanonicalJson.isLowerHex(b.inboxPub, bytes: 1216), CanonicalJson.isLowerHex(b.ownerSignPub, bytes: 32) else { throw bad("keys") }
        if let pp = piecesProblem(b.pieces) { throw bad(pp) }
        guard b.signerKind == "admin-root" || b.signerKind == "irk" else { throw bad("signerKind") }
        guard CanonicalJson.isLowerHex(b.signerPub, bytes: 32) else { throw bad("signerPub") }
        return CanonicalJson.join([tagVoiciPage, b.username, b.pageId, String(b.seq), String(b.issuedAt), String(b.acceptsMessages),
                                   String(b.inboxEpoch), b.inboxPub, b.ownerSignPub, b.pieces.map(\.key).joined(separator: ","),
                                   b.signerKind, b.signerPub])
    }

    /// Sorts the pieces, sets signerPub from the seed, signs (randomized Ed25519: verify, never compare bytes).
    public static func signVoiciPageIndex(_ body: VoiciPageIndex, signerSeed: [UInt8]) throws -> VoiciPageIndex {
        var full = body
        full.pieces = stableSorted(body.pieces) { CanonicalJson.utf16Less($0.key, $1.key) ? -1 : CanonicalJson.utf16Less($1.key, $0.key) ? 1 : 0 }
        full.signerPub = CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: signerSeed))
        full.signature = try CanonicalJson.ed25519SignHex(try canonicalVoiciPageIndex(full), seed: signerSeed)
        return full
    }

    static let indexKeys: Set<String> = ["kind", "version", "username", "pageId", "seq", "issuedAt", "acceptsMessages", "inboxEpoch",
                                         "inboxPub", "ownerSignPub", "pieces", "signerKind", "signerPub", "signature"]

    /// Strict shape of an untrusted index (`.string` = JSON text of at most 300 KiB, else a parsed value).
    public static func parseVoiciPageIndex(_ input: JSONValue) -> VoiciPageIndex? {
        var v = input
        if case .string(let text) = input {
            guard text.utf8.count <= indexMaxBytes, let p = JSONValue.parse(text) else { return nil }
            v = p
        }
        guard let r = v.object, exactKeys(r, indexKeys), r["kind"]?.string == "VoiciPage", r["version"]?.isOne == true,
              CanonicalJson.isLowerHex(r["signature"], bytes: 64),
              let username = r["username"]?.string, let pageId = r["pageId"]?.string, let seq = r["seq"]?.safeInt,
              let issuedAt = r["issuedAt"]?.safeInt, let accepts = r["acceptsMessages"]?.safeInt, let epoch = r["inboxEpoch"]?.safeInt,
              let inboxPub = r["inboxPub"]?.string, let ownerSignPub = r["ownerSignPub"]?.string, let rawPieces = r["pieces"]?.array,
              let signerKind = r["signerKind"]?.string, let signerPub = r["signerPub"]?.string else { return nil }
        var pieces: [VoiciPieceRef] = []
        for p in rawPieces {
            guard let o = p.object, exactKeys(o, ["role", "sha256", "size"]), let role = o["role"]?.string,
                  let sha = o["sha256"]?.string, let size = o["size"]?.safeInt else { return nil }
            pieces.append(VoiciPieceRef(role: role, sha256: sha, size: size))
        }
        let idx = VoiciPageIndex(username: username, pageId: pageId, seq: seq, issuedAt: issuedAt, acceptsMessages: accepts,
                                 inboxEpoch: epoch, inboxPub: inboxPub, ownerSignPub: ownerSignPub, pieces: pieces,
                                 signerKind: signerKind, signerPub: signerPub, signature: r["signature"]!.string!)
        return (try? canonicalVoiciPageIndex(idx)) != nil ? idx : nil
    }

    /// A reader's check: shape, username, signer = the account's current sensitive key (and kind), the signature,
    /// pageId when given, and anti-rollback against `highestSeenSeq` (§2.9).
    public static func checkVoiciPageIndex(_ input: JSONValue, username: String, sensitiveKind: String, sensitivePub: String,
                                           highestSeenSeq: Int64? = nil, pageId: String? = nil) -> VoiciVerdict<VoiciPageIndex, VoiciPageIndex.Refusal> {
        guard let idx = parseVoiciPageIndex(input) else { return .refused(.malformed) }
        if !CanonicalJson.same(idx.username, username) { return .refused(.wrongUsername) }
        if !CanonicalJson.same(idx.signerKind, sensitiveKind) || !CanonicalJson.same(idx.signerPub, sensitivePub) { return .refused(.notSensitiveKey) }
        guard let bytes = try? canonicalVoiciPageIndex(idx), CanonicalJson.ed25519VerifyHex(idx.signature, bytes, idx.signerPub) else { return .refused(.badSignature) }
        if let pageId, !CanonicalJson.same(idx.pageId, pageId) { return .refused(.wrongPage) }
        if let seen = highestSeenSeq, idx.seq < seen { return .refused(.rolledBack) }
        return .ok(idx)
    }

    /// `.com`'s publish check after the reader's: issuedAt within 10 minutes, seq = stored + 1, pageId unchanged.
    public static func checkVoiciPublish(_ input: JSONValue, username: String, sensitiveKind: String, sensitivePub: String,
                                         storedSeq: Int64, storedPageId: String?, now: Int64) -> VoiciVerdict<VoiciPageIndex, VoiciPageIndex.Refusal> {
        let r = checkVoiciPageIndex(input, username: username, sensitiveKind: sensitiveKind, sensitivePub: sensitivePub)
        guard case .ok(let idx) = r else { return r }
        if abs(idx.issuedAt - now) > indexSkewMs { return .refused(.stale) }
        if idx.seq != storedSeq + 1 { return .refused(.seqConflict) }
        if let stored = storedPageId, !CanonicalJson.same(idx.pageId, stored) { return .refused(.wrongPage) }
        return r
    }

    /// The pieces the content names are the pieces the index lists (avatar, card images, chunk count).
    public static func voiciPieceRefsOk(_ index: VoiciPageIndex, profile: VoiciProfile, chunks: [VoiciChunk]) -> Bool {
        var byRole: [String: String] = [:]
        for p in index.pieces { byRole[p.role] = p.sha256 }
        if profile.avatar != byRole["avatar"] { return false }
        let nChunks = index.pieces.filter { $0.role.hasPrefix("chunk-") }.count
        if chunks.count != nChunks || chunks.enumerated().contains(where: { $0.element.chunk != Int64($0.offset) }) { return false }
        var cards = Set<String>()
        for c in chunks { for p in c.posts { for l in p.links { if let img = l.card?.image { cards.insert(img) } } } }
        let listed = index.pieces.filter { $0.role.hasPrefix("card-") }
        return listed.count == cards.count && listed.allSatisfy { cards.contains($0.sha256) }
    }

    // MARK: piece upload

    public static func canonicalVoiciPieceUpload(_ u: VoiciPieceUpload) throws -> [UInt8] {
        guard isUsername(u.username), isPageId(u.pageId), CanonicalJson.isLowerHex(u.sha256, bytes: 32), CanonicalJson.isTime(u.size),
              u.size >= 1, CanonicalJson.isTime(u.issuedAt) else { throw CanonicalJsonError("\(tagVoiciPieceUpload): bad field") }
        return CanonicalJson.join([tagVoiciPieceUpload, u.username, u.pageId, u.sha256, String(u.size), String(u.issuedAt)])
    }

    public static func signVoiciPieceUpload(_ u: VoiciPieceUpload, signerSeed: [UInt8]) throws -> String {
        try CanonicalJson.ed25519SignHex(try canonicalVoiciPieceUpload(u), seed: signerSeed)
    }

    public static func verifyVoiciPieceUpload(_ u: VoiciPieceUpload, signature: String, signerPub: String) -> Bool {
        guard let bytes = try? canonicalVoiciPieceUpload(u) else { return false }
        return CanonicalJson.ed25519VerifyHex(signature, bytes, signerPub)
    }

    // MARK: chunking and the merge (§5.3)

    /// A stable sort with a JavaScript-style comparator (Array.prototype.sort is stable).
    static func stableSorted<T>(_ a: [T], _ cmp: (T, T) -> Int) -> [T] {
        a.enumerated().sorted { x, y in
            let c = cmp(x.element, y.element)
            return c != 0 ? c < 0 : x.offset < y.offset
        }.map(\.element)
    }

    static func byCreation(_ a: VoiciPost, _ b: VoiciPost) -> Int {
        if a.createdAt != b.createdAt { return a.createdAt < b.createdAt ? -1 : 1 }
        return CanonicalJson.utf16Less(a.id, b.id) ? -1 : CanonicalJson.utf16Less(b.id, a.id) ? 1 : 0
    }

    static func stamp(_ p: VoiciPost) -> Int64 { p.editedAt ?? p.createdAt }

    /// Posts (any order) into fresh chunks of at most 20, creation order: for a first publish.
    public static func chunkVoiciPosts(_ posts: [VoiciPost]) -> [[VoiciPost]] {
        let sorted = stableSorted(posts, byCreation)
        return stride(from: 0, to: sorted.count, by: chunkMaxPosts).map { Array(sorted[$0..<min($0 + chunkMaxPosts, sorted.count)]) }
    }

    /// Applies pending draft ops to a published state in (at, opId) order (see the TS doc for the rules). Pure.
    public static func mergeVoiciPage(_ published: VoiciPageState, ops: [VoiciDraftOp]) -> VoiciPageState {
        var chunks = published.chunks
        var profile = published.profile
        var profileAt = published.issuedAt
        var accepts = published.acceptsMessages
        var acceptsAt = published.issuedAt
        func find(_ id: String) -> (Int, Int)? {
            for c in chunks.indices { if let i = chunks[c].firstIndex(where: { $0.id == id }) { return (c, i) } }
            return nil
        }
        let sorted = stableSorted(ops) { a, b in
            if a.at != b.at { return a.at < b.at ? -1 : 1 }
            return CanonicalJson.utf16Less(a.opId, b.opId) ? -1 : CanonicalJson.utf16Less(b.opId, a.opId) ? 1 : 0
        }
        for op in sorted {
            if op.op == "post-add" || op.op == "post-edit", let post = op.post {
                if let (c, i) = find(post.id) {
                    if stamp(post) > stamp(chunks[c][i]) {
                        chunks[c][i] = post
                        chunks[c] = stableSorted(chunks[c], byCreation)
                    }
                } else if op.op == "post-add" {
                    if chunks.isEmpty || chunks[chunks.count - 1].count >= chunkMaxPosts { chunks.append([]) }
                    chunks[chunks.count - 1].append(post)
                    chunks[chunks.count - 1] = stableSorted(chunks[chunks.count - 1], byCreation)
                }
            } else if op.op == "post-delete", let id = op.postId {
                if let (c, i) = find(id) { chunks[c].remove(at: i) }
            } else if op.op == "profile", let p = op.profile, op.at > profileAt {
                profile = p
                profileAt = op.at
            } else if op.op == "accept-messages", let a = op.accepts, op.at > acceptsAt {
                accepts = a
                acceptsAt = op.at
            }
        }
        return VoiciPageState(profile: profile, acceptsMessages: accepts, chunks: chunks, issuedAt: published.issuedAt)
    }
}
