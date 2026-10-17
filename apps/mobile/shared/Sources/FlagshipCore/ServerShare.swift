import Foundation
import CryptoKit

/// Swift mirror of `@flagship/protocol`'s `serverShare.ts` (docs/share-a-server.md):
/// sharing a server with another account. The twelve `|`-joined envelopes, the
/// link-secret derivations, the six-digit code both phones show, and the sealed
/// JSON payloads `.com` relays without being able to read.
///
/// `packages/protocol/test-vectors/server-share/vectors.json` is the
/// cross-platform reference (asserted by `ServerShareVectorTests`).
public enum ServerShare {
    public static let tagGrant = "flagship/server-share/v1"
    public static let tagRevoke = "flagship/server-share-revoke/v1"
    public static let tagAccept = "flagship/server-share-accept/v1"
    public static let tagLeave = "flagship/server-share-leave/v1"
    public static let tagSession = "flagship/server-share-session/v1"
    public static let tagOffer = "flagship/server-share-offer/v1"
    public static let tagList = "flagship/server-share-list/v1"
    public static let tagUnlock = "flagship/server-share-unlock/v1"
    public static let tagInbox = "flagship/share-inbox/v1"
    public static let tagPush = "flagship/server-share-push/v1"
    public static let tagUpdate = "flagship/server-share-update/v1"
    public static let tagAcceptAdmin = "flagship/server-share-accept-admin/v1"

    static let infoMember = "flagship/server-share-member/v1"
    static let infoToken = "flagship/server-share/token/v1"
    static let infoLinkKey = "flagship/server-share/link-key/v1"
    static let infoInbox = "flagship/share-inbox/v1"
    static let infoInboxKey = "flagship/share-inbox-key/v1"
    static let infoInviteBundle = "flagship/share-invite-bundle/v1"
    static let sasTag = "flagship/server-share/sas/v1"

    public static let aadOffer = "flagship/server-share/offer/v1"
    public static let aadAcceptance = "flagship/server-share/acceptance/v1"
    public static let aadOwner = "flagship/server-share/owner/v1"
    public static let aadInboxEntry = "flagship/share-inbox/entry/v1"

    /// How long B has to accept a link.
    public static let offerTtlMs: Int64 = 7 * 24 * 3600 * 1000
    public static let labelMax = 64
    /// `sealedSha256` value that withdraws B's boot copy.
    public static let unlockOff = "off"

    // MARK: Keys

    /// B's identity toward one share (so one server): unlinkable everywhere else.
    public static func deriveShareMemberKey(umkSeed: Data, shareId: String) throws -> Curve25519.Signing.PrivateKey {
        try checkSeed(umkSeed)
        try checkShareId(shareId)
        return try Curve25519.Signing.PrivateKey(rawRepresentation: hk(umkSeed, "\(infoMember)|\(shareId)"))
    }

    /// Signs B's "Shared with me" inbox requests; its public key is the inbox id.
    public static func deriveShareInboxKey(umkSeed: Data) throws -> Curve25519.Signing.PrivateKey {
        try checkSeed(umkSeed)
        return try Curve25519.Signing.PrivateKey(rawRepresentation: hk(umkSeed, infoInbox))
    }

    /// Seals B's inbox entries.
    public static func deriveShareInboxSealKey(umkSeed: Data) throws -> Data {
        try checkSeed(umkSeed)
        return hk(umkSeed, infoInboxKey)
    }

    /// Seals the names of the people B invites to the shared server's apps
    /// (AES-256-GCM key). Only B's devices derive it; the owner can't read them.
    public static func deriveShareInviteBundleKey(umkSeed: Data, shareId: String) throws -> Data {
        try checkSeed(umkSeed)
        try checkShareId(shareId)
        return hk(umkSeed, "\(infoInviteBundle)|\(shareId)")
    }

    /// The bearer token the link grants (`x-flagship-share-token`), lowercase hex.
    public static func shareTokenFromSecret(_ secret: Data) throws -> String {
        try checkSecret(secret)
        return HexUtil.encode(hk(secret, infoToken))
    }

    /// What `.com` stores for the token: SHA-256 hex of the token's bytes.
    public static func shareTokenHash(_ tokenHex: String) throws -> String {
        guard isLowerHex(tokenHex, 64), let bytes = HexUtil.decode(tokenHex) else {
            throw ServerShareError.invalid("server-share: token must be 64 lowercase hex")
        }
        return HexUtil.encode(Data(SHA256.hash(data: bytes)))
    }

    /// AES-256-GCM key for the offer and the acceptance.
    public static func shareLinkKey(_ secret: Data) throws -> Data {
        try checkSecret(secret)
        return hk(secret, infoLinkKey)
    }

    /// The six digits both phones show, as `"123456"`.
    public static func shareSas(shareId: String, memberPubHex: String, secret: Data) throws -> String {
        try checkShareId(shareId)
        try checkHex64("memberPubHex", memberPubHex)
        try checkSecret(secret)
        let d = Array(SHA256.hash(data: Data([sasTag, shareId, memberPubHex, HexUtil.encode(secret)].joined(separator: "|").utf8)))
        let n = (UInt32(d[0]) << 24) | (UInt32(d[1]) << 16) | (UInt32(d[2]) << 8) | UInt32(d[3])
        let s = String(n % 1_000_000)
        return String(repeating: "0", count: 6 - s.count) + s
    }

    /// `"123456"` → `"123 456"`.
    public static func formatShareSas(_ sas: String) -> String {
        "\(sas.prefix(3)) \(sas.dropFirst(3))"
    }

    // MARK: Sealed JSON payloads (lowercase hex `nonce12 || ct+tag`)

    public static func shareAad(_ prefix: String, _ id: String) throws -> Data {
        try legacyFieldGuard("aad id", id)
        return Data("\(prefix)|\(id)".utf8)
    }

    /// Seals the exact plaintext bytes. `nonce` is for test vectors only.
    public static func seal(key: Data, aad: Data, plaintext: Data, nonce: Data? = nil) throws -> String {
        guard key.count == 32 else { throw ServerShareError.invalid("server-share: key must be 32 bytes") }
        let n = nonce ?? randomBytes(12)
        guard n.count == 12 else { throw ServerShareError.invalid("server-share: nonce must be 12 bytes") }
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: n), authenticating: aad)
        var out = n
        out.append(box.ciphertext)
        out.append(box.tag)
        return HexUtil.encode(out)
    }

    /// Throws on a wrong key, wrong AAD or tampered ciphertext. Returns the plaintext
    /// bytes, which must be valid UTF-8.
    public static func open(key: Data, aad: Data, sealedHex: String) throws -> Data {
        guard key.count == 32 else { throw ServerShareError.invalid("server-share: key must be 32 bytes") }
        guard !sealedHex.isEmpty, sealedHex.utf8.count % 2 == 0, isLowerHex(sealedHex, sealedHex.utf8.count),
              let buf = HexUtil.decode(sealedHex)
        else { throw ServerShareError.invalid("server-share: sealed payload must be hex") }
        guard buf.count >= 12 + 16 else { throw ServerShareError.invalid("server-share: sealed payload too short") }
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: buf.prefix(12)),
            ciphertext: buf.dropFirst(12).dropLast(16),
            tag: buf.suffix(16)
        )
        let plain = try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
        guard String(data: plain, encoding: .utf8) != nil else {
            throw ServerShareError.invalid("server-share: sealed payload is not UTF-8")
        }
        return plain
    }

    /// `open` + JSON parse (fragments allowed, like `JSON.parse`).
    public static func openJSON(key: Data, aad: Data, sealedHex: String) throws -> Any {
        try JSONSerialization.jsonObject(with: open(key: key, aad: aad, sealedHex: sealedHex), options: [.fragmentsAllowed])
    }

    // MARK: The link: https://<apex>/share#s=<shareId>&k=<secretHex>

    public struct LinkParts: Equatable, Sendable {
        public let shareId: String
        public let secretHex: String

        public init(shareId: String, secretHex: String) {
            self.shareId = shareId
            self.secretHex = secretHex
        }
    }

    public static func buildShareLink(apexOrigin: String, shareId: String, secret: Data) throws -> String {
        try checkShareId(shareId)
        try checkSecret(secret)
        var apex = apexOrigin
        while apex.hasSuffix("/") { apex.removeLast() }
        return "\(apex)/share#s=\(shareId)&k=\(HexUtil.encode(secret))"
    }

    /// Accepts the https link (fragment), `flagship://share?s=&k=`, or a bare
    /// `s=…&k=…`. Returns nil for anything else.
    public static func parseShareLink(_ text: String) -> LinkParts? {
        let t = jsTrim(text)
        let hash = t.firstIndex(of: "#")
        let q = t.firstIndex(of: "?")
        let lower = t.lowercased()
        let params: Substring
        if lower.hasPrefix("https://") || lower.hasPrefix("http://") {
            guard let hash else { return nil }
            guard let comps = URLComponents(string: t) else { return nil }
            let path = comps.percentEncodedPath.isEmpty ? "/" : comps.percentEncodedPath
            guard path == "/share" else { return nil }
            params = t[t.index(after: hash)...]
        } else if lower.hasPrefix("flagship://share") {
            if let q { params = t[t.index(after: q)...] }
            else if let hash { params = t[t.index(after: hash)...] }
            else { params = "" }
        } else {
            params = t[...]
        }
        var s: String?
        var k: String?
        for part in params.split(separator: "&", omittingEmptySubsequences: false) {
            guard let eq = part.firstIndex(of: "=") else { continue }
            let key = part[..<eq]
            let value = part[part.index(after: eq)...].lowercased()
            if key == "s" { s = value }
            if key == "k" { k = value }
        }
        guard let s, let k, isLowerHex(s, 32), isLowerHex(k, 64) else { return nil }
        return LinkParts(shareId: s, secretHex: k)
    }

    // MARK: Helpers

    /// Trimmed label, or nil when it can't be a label (empty, too long, `|`, control chars).
    public static func normalizeShareLabel(_ raw: String) -> String? {
        let t = jsTrim(raw)
        if t.isEmpty || t.unicodeScalars.count > labelMax { return nil }
        if t.unicodeScalars.contains(where: { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f }) { return nil }
        return t
    }

    /// SHA-256 hex of a string's UTF-8 bytes (the `*Sha256` fields).
    public static func shareSha256Hex(_ s: String) -> String {
        HexUtil.encode(Data(SHA256.hash(data: Data(s.utf8))))
    }

    /// 16 random bytes as 32 lowercase hex (share ids, inbox entry ids).
    public static func randomShareId() -> String {
        HexUtil.encode(randomBytes(16))
    }

    static func randomBytes(_ n: Int) -> Data {
        var g = SystemRandomNumberGenerator()
        return Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &g) })
    }

    static func hk(_ ikm: Data, _ info: String) -> Data {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: Data(),
            info: Data(info.utf8),
            outputByteCount: 32
        ).withUnsafeBytes { Data($0) }
    }

    /// `String.prototype.trim`: JS WhiteSpace + LineTerminator, by code point.
    static func jsTrim(_ s: String) -> String {
        func ws(_ u: Unicode.Scalar) -> Bool {
            switch u.value {
            case 0x09...0x0d, 0x20, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
                return true
            default:
                return false
            }
        }
        var scalars = Substring(s).unicodeScalars
        while let f = scalars.first, ws(f) { scalars.removeFirst() }
        while let l = scalars.last, ws(l) { scalars.removeLast() }
        return String(Substring(scalars))
    }

    static func isLowerHex(_ s: String, _ count: Int) -> Bool {
        s.utf8.count == count && s.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }

    static func legacyFieldGuard(_ name: String, _ v: String) throws {
        for u in v.unicodeScalars where u.value == 0x7c || u.value <= 0x1f || u.value == 0x7f {
            throw ServerShareError.invalid("canonical-bytes field \"\(name)\" contains a separator or control char")
        }
    }

    static func nonEmpty(_ name: String, _ v: String) throws {
        if v.isEmpty { throw ServerShareError.invalid("server-share: empty \(name)") }
        try legacyFieldGuard(name, v)
    }

    static func checkShareId(_ v: String) throws {
        if !isLowerHex(v, 32) { throw ServerShareError.invalid("server-share: shareId must be 32 lowercase hex") }
    }

    static func checkHex64(_ name: String, _ v: String) throws {
        if !isLowerHex(v, 64) { throw ServerShareError.invalid("server-share: \(name) must be 64 lowercase hex") }
    }

    static func checkCommit(_ name: String, _ v: String) throws {
        if !isLowerHex(v, 40) { throw ServerShareError.invalid("server-share: \(name) must be 40 lowercase hex") }
    }

    static func checkSecret(_ s: Data) throws {
        if s.count != 32 { throw ServerShareError.invalid("server-share: link secret must be 32 bytes") }
    }

    static func checkSeed(_ s: Data) throws {
        if s.count != 32 { throw ServerShareError.invalid("server-share: UMK seed must be 32 bytes") }
    }

    static func isTime(_ v: Int64) -> Bool { v >= 0 && v <= 9_007_199_254_740_991 }

    static func time(_ name: String, _ v: Int64) throws {
        if !isTime(v) { throw ServerShareError.invalid("server-share: bad \(name)") }
    }

    static func join(_ tag: String, _ fields: [String]) -> Data {
        Data(([tag] + fields).joined(separator: "|").utf8)
    }

    // Untrusted-JSON helpers: `typeof x === "number"` / `"boolean"` without
    // letting a JSON `true` pass as `1` (or the reverse).
    static func jsonBool(_ v: Any?) -> Bool? {
        guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }

    static func jsonTime(_ v: Any?) -> Int64? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d == d.rounded(), d >= 0, d <= 9_007_199_254_740_991 else { return nil }
        return Int64(d)
    }

    static func jsonIsOne(_ v: Any?) -> Bool {
        jsonTime(v) == 1
    }

    /// `JSON.stringify` of a string (no `\/` escaping).
    static func jsonString(_ s: String) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed, .withoutEscapingSlashes]),
              let out = String(data: d, encoding: .utf8)
        else { return "\"\"" }
        return out
    }
}

public enum ServerShareError: Error, Equatable, Sendable {
    case invalid(String)
}

public enum ServerShareLevel: String, Codable, Sendable, CaseIterable {
    case view
    case manage
}

public enum ShareInboxOp: String, Codable, Sendable, CaseIterable {
    case put
    case list
    case delete
}

public enum SharePushOp: String, Codable, Sendable, CaseIterable {
    case put
    case delete
}

public enum SharePushPlatform: String, Codable, Sendable, CaseIterable {
    case apns
    case fcm
    case webpush
}

// MARK: - Envelopes

public protocol ServerShareEnvelope: Codable, Equatable, Sendable {
    func canonicalBytes() throws -> Data
}

extension ServerShareEnvelope {
    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }

    /// For signers that never surface their seed (e.g. a Keystore-held key).
    public func sign(using signer: (Data) throws -> Data) throws -> Data {
        try signer(canonicalBytes())
    }

    public func verify(signature: Data, publicKey: Data) -> Bool {
        guard let msg = try? canonicalBytes(),
              let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey)
        else { return false }
        return pub.isValidSignature(signature, for: msg)
    }

    /// Untrusted JSON → envelope (shape, then the canonical builder re-checks).
    public static func parse(_ data: Data) -> Self? {
        guard let v = try? JSONDecoder().decode(Self.self, from: data), (try? v.canonicalBytes()) != nil else { return nil }
        return v
    }

    public static func parse(jsonObject: Any) -> Self? {
        guard JSONSerialization.isValidJSONObject(jsonObject),
              let data = try? JSONSerialization.data(withJSONObject: jsonObject)
        else { return nil }
        return parse(data)
    }
}

/// #1 — signed by A's sensitive key; the box keeps the newest per shareId.
public struct ServerShareGrant: ServerShareEnvelope {
    public var serverDomain: String
    public var shareId: String
    public var memberPubHex: String
    public var level: ServerShareLevel
    public var unlockAtBoot: Bool
    public var seeAppData: Bool
    /// A's name for B on this server.
    public var label: String
    public var issuedAt: Int64

    public init(serverDomain: String, shareId: String, memberPubHex: String, level: ServerShareLevel,
                unlockAtBoot: Bool, seeAppData: Bool, label: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.shareId = shareId
        self.memberPubHex = memberPubHex
        self.level = level
        self.unlockAtBoot = unlockAtBoot
        self.seeAppData = seeAppData
        self.label = label
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("serverDomain", serverDomain)
        try ServerShare.checkShareId(shareId)
        try ServerShare.checkHex64("memberPubHex", memberPubHex)
        guard ServerShare.normalizeShareLabel(label) == label else {
            throw ServerShareError.invalid("server-share: label must be 1-64 trimmed characters")
        }
        try ServerShare.time("issuedAt", issuedAt)
        return ServerShare.join(ServerShare.tagGrant, [
            serverDomain, shareId, memberPubHex, level.rawValue,
            unlockAtBoot ? "1" : "0", seeAppData ? "1" : "0", label, String(issuedAt),
        ])
    }
}

/// #2 — signed by A's sensitive key; ends the share id forever.
public struct ServerShareRevoke: ServerShareEnvelope {
    public var serverDomain: String
    public var shareId: String
    public var issuedAt: Int64

    public init(serverDomain: String, shareId: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.shareId = shareId
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("serverDomain", serverDomain)
        try ServerShare.checkShareId(shareId)
        try ServerShare.time("issuedAt", issuedAt)
        return ServerShare.join(ServerShare.tagRevoke, [serverDomain, shareId, String(issuedAt)])
    }
}

/// #3 — signed by B's member key.
public struct ServerShareAccept: ServerShareEnvelope {
    public var serverDomain: String
    public var shareId: String
    public var memberPubHex: String
    public var acceptedAt: Int64

    public init(serverDomain: String, shareId: String, memberPubHex: String, acceptedAt: Int64) {
        self.serverDomain = serverDomain
        self.shareId = shareId
        self.memberPubHex = memberPubHex
        self.acceptedAt = acceptedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("serverDomain", serverDomain)
        try ServerShare.checkShareId(shareId)
        try ServerShare.checkHex64("memberPubHex", memberPubHex)
        try ServerShare.time("acceptedAt", acceptedAt)
        return ServerShare.join(ServerShare.tagAccept, [serverDomain, shareId, memberPubHex, String(acceptedAt)])
    }
}

/// Which of an account's keys is its sensitive key: the admin root, or the IRK
/// when the account pins no admin root (`authorizeSensitiveOrder`'s rule).
public enum AccountKeyKind: String, Codable, Sendable, CaseIterable {
    case adminRoot = "admin-root"
    case irk
}

/// #12 — signed by the joining account's sensitive key: only an admin device of
/// that account accepts a share (docs/share-a-server.md §5.1). The fields of #3
/// plus which key signs, so the shared server can match it to the attestation.
public struct ServerShareAcceptAdmin: ServerShareEnvelope {
    public var serverDomain: String
    public var shareId: String
    public var memberPubHex: String
    public var acceptedAt: Int64
    public var keyKind: AccountKeyKind
    public var keyPubHex: String

    public init(serverDomain: String, shareId: String, memberPubHex: String, acceptedAt: Int64,
                keyKind: AccountKeyKind, keyPubHex: String) {
        self.serverDomain = serverDomain
        self.shareId = shareId
        self.memberPubHex = memberPubHex
        self.acceptedAt = acceptedAt
        self.keyKind = keyKind
        self.keyPubHex = keyPubHex
    }

    public init(accept: ServerShareAccept, keyKind: AccountKeyKind, keyPubHex: String) {
        self.init(serverDomain: accept.serverDomain, shareId: accept.shareId, memberPubHex: accept.memberPubHex,
                  acceptedAt: accept.acceptedAt, keyKind: keyKind, keyPubHex: keyPubHex)
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("serverDomain", serverDomain)
        try ServerShare.checkShareId(shareId)
        try ServerShare.checkHex64("memberPubHex", memberPubHex)
        try ServerShare.time("acceptedAt", acceptedAt)
        try ServerShare.checkHex64("keyPubHex", keyPubHex)
        return ServerShare.join(ServerShare.tagAcceptAdmin, [
            serverDomain, shareId, memberPubHex, String(acceptedAt), keyKind.rawValue, keyPubHex,
        ])
    }

    func jsonFragment() -> String {
        let j = ServerShare.jsonString
        return "{\"serverDomain\":\(j(serverDomain)),\"shareId\":\(j(shareId)),\"memberPubHex\":\(j(memberPubHex))," +
            "\"acceptedAt\":\(acceptedAt),\"keyKind\":\(j(keyKind.rawValue)),\"keyPubHex\":\(j(keyPubHex))}"
    }
}

/// `.com`'s CA-signed word that a key is some account's current sensitive key
/// (`flagship/account-key-attestation/v1`). It names no account. The apps check
/// its shape only and carry it unchanged; the shared server checks the CA chain.
public struct AccountKeyAttestation: Codable, Equatable, Sendable {
    public var keyKind: AccountKeyKind
    public var keyPubHex: String
    public var issuedAt: Int64
    public var expiresAt: Int64
    public var signedBy: String
    public var signature: String

    public init(keyKind: AccountKeyKind, keyPubHex: String, issuedAt: Int64, expiresAt: Int64, signedBy: String, signature: String) {
        self.keyKind = keyKind
        self.keyPubHex = keyPubHex
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.signedBy = signedBy
        self.signature = signature
    }

    public init?(jsonObject v: Any) {
        guard let o = v as? [String: Any],
              o["kind"] as? String == "AccountKeyAttestation", ServerShare.jsonIsOne(o["version"]),
              let k = o["keyKind"] as? String, let keyKind = AccountKeyKind(rawValue: k),
              let keyPubHex = o["keyPubHex"] as? String, ServerShare.isLowerHex(keyPubHex, 64),
              let signedBy = o["signedBy"] as? String, ServerShare.isLowerHex(signedBy, 64),
              let signature = o["signature"] as? String, ServerShare.isLowerHex(signature, 128),
              let issuedAt = ServerShare.jsonTime(o["issuedAt"]),
              let expiresAt = ServerShare.jsonTime(o["expiresAt"]), expiresAt > issuedAt
        else { return nil }
        self.init(keyKind: keyKind, keyPubHex: keyPubHex, issuedAt: issuedAt, expiresAt: expiresAt, signedBy: signedBy, signature: signature)
    }

    private enum CodingKeys: String, CodingKey {
        case kind, version, keyKind, keyPubHex, issuedAt, expiresAt, signedBy, signature
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard try c.decode(String.self, forKey: .kind) == "AccountKeyAttestation", try c.decode(Int.self, forKey: .version) == 1 else {
            throw ServerShareError.invalid("not an AccountKeyAttestation")
        }
        let a = AccountKeyAttestation(
            keyKind: try c.decode(AccountKeyKind.self, forKey: .keyKind),
            keyPubHex: try c.decode(String.self, forKey: .keyPubHex),
            issuedAt: try c.decode(Int64.self, forKey: .issuedAt),
            expiresAt: try c.decode(Int64.self, forKey: .expiresAt),
            signedBy: try c.decode(String.self, forKey: .signedBy),
            signature: try c.decode(String.self, forKey: .signature))
        guard ServerShare.isLowerHex(a.keyPubHex, 64), ServerShare.isLowerHex(a.signedBy, 64),
              ServerShare.isLowerHex(a.signature, 128), ServerShare.isTime(a.issuedAt), a.expiresAt > a.issuedAt
        else { throw ServerShareError.invalid("malformed AccountKeyAttestation") }
        self = a
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode("AccountKeyAttestation", forKey: .kind)
        try c.encode(1, forKey: .version)
        try c.encode(keyKind, forKey: .keyKind)
        try c.encode(keyPubHex, forKey: .keyPubHex)
        try c.encode(issuedAt, forKey: .issuedAt)
        try c.encode(expiresAt, forKey: .expiresAt)
        try c.encode(signedBy, forKey: .signedBy)
        try c.encode(signature, forKey: .signature)
    }

    func jsonFragment() -> String {
        let j = ServerShare.jsonString
        return "{\"kind\":\"AccountKeyAttestation\",\"version\":1,\"keyKind\":\(j(keyKind.rawValue)),\"keyPubHex\":\(j(keyPubHex))," +
            "\"issuedAt\":\(issuedAt),\"expiresAt\":\(expiresAt),\"signedBy\":\(j(signedBy)),\"signature\":\(j(signature))}"
    }

    public func jsonObject() -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(jsonFragment().utf8))) as? [String: Any] ?? [:]
    }
}

/// The joining account's admin proof sealed with an acceptance: #12, its
/// signature, and `.com`'s attestation of the key that signed it.
public struct ShareAcceptAdminProof: Encodable, Equatable, Sendable {
    public var admit: ServerShareAcceptAdmin
    public var signature: String
    public var attestation: AccountKeyAttestation

    public init(admit: ServerShareAcceptAdmin, signature: String, attestation: AccountKeyAttestation) {
        self.admit = admit
        self.signature = signature
        self.attestation = attestation
    }

    public init?(jsonObject v: Any) {
        guard let o = v as? [String: Any],
              let signature = o["signature"] as? String, ServerShare.isLowerHex(signature, 128),
              let a = o["admit"] as? [String: Any],
              let serverDomain = a["serverDomain"] as? String,
              let shareId = a["shareId"] as? String,
              let memberPubHex = a["memberPubHex"] as? String,
              let acceptedAt = ServerShare.jsonTime(a["acceptedAt"]),
              let k = a["keyKind"] as? String, let keyKind = AccountKeyKind(rawValue: k),
              let keyPubHex = a["keyPubHex"] as? String,
              let attestation = o["attestation"].flatMap({ AccountKeyAttestation(jsonObject: $0) })
        else { return nil }
        let admit = ServerShareAcceptAdmin(serverDomain: serverDomain, shareId: shareId, memberPubHex: memberPubHex,
                                           acceptedAt: acceptedAt, keyKind: keyKind, keyPubHex: keyPubHex)
        guard (try? admit.canonicalBytes()) != nil else { return nil }
        self.init(admit: admit, signature: signature, attestation: attestation)
    }

    func jsonFragment() -> String {
        "{\"admit\":\(admit.jsonFragment()),\"signature\":\(ServerShare.jsonString(signature)),\"attestation\":\(attestation.jsonFragment())}"
    }

    /// As the box takes it in `POST /api/screens/shares` (`acceptAdmin`).
    public func jsonObject() -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(jsonFragment().utf8))) as? [String: Any] ?? [:]
    }
}

/// #4 — signed by B's member key; ends the share id forever.
public struct ServerShareLeave: ServerShareEnvelope {
    public var serverDomain: String
    public var shareId: String
    public var memberPubHex: String
    public var issuedAt: Int64

    public init(serverDomain: String, shareId: String, memberPubHex: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.shareId = shareId
        self.memberPubHex = memberPubHex
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("serverDomain", serverDomain)
        try ServerShare.checkShareId(shareId)
        try ServerShare.checkHex64("memberPubHex", memberPubHex)
        try ServerShare.time("issuedAt", issuedAt)
        return ServerShare.join(ServerShare.tagLeave, [serverDomain, shareId, memberPubHex, String(issuedAt)])
    }
}

/// #5 — signed by B's member key over a box nonce.
public struct ServerShareSession: ServerShareEnvelope {
    public var serverDomain: String
    public var shareId: String
    public var memberPubHex: String
    public var nonceHex: String
    public var issuedAt: Int64

    public init(serverDomain: String, shareId: String, memberPubHex: String, nonceHex: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.shareId = shareId
        self.memberPubHex = memberPubHex
        self.nonceHex = nonceHex
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("serverDomain", serverDomain)
        try ServerShare.checkShareId(shareId)
        try ServerShare.checkHex64("memberPubHex", memberPubHex)
        try ServerShare.checkHex64("nonceHex", nonceHex)
        try ServerShare.time("issuedAt", issuedAt)
        return ServerShare.join(ServerShare.tagSession, [serverDomain, shareId, memberPubHex, nonceHex, String(issuedAt)])
    }
}

/// #6 — signed by A's sensitive key; creates the `.com` offer row.
public struct ServerShareOffer: ServerShareEnvelope {
    public var username: String
    public var serverDomain: String
    public var shareId: String
    public var tokenHash: String
    /// SHA-256 hex of the sealed offer hex.
    public var offerSha256: String
    /// SHA-256 hex of the sealed owner-record hex.
    public var ownerSha256: String
    public var expiresAt: Int64
    public var issuedAt: Int64

    public init(username: String, serverDomain: String, shareId: String, tokenHash: String,
                offerSha256: String, ownerSha256: String, expiresAt: Int64, issuedAt: Int64) {
        self.username = username
        self.serverDomain = serverDomain
        self.shareId = shareId
        self.tokenHash = tokenHash
        self.offerSha256 = offerSha256
        self.ownerSha256 = ownerSha256
        self.expiresAt = expiresAt
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("username", username)
        try ServerShare.nonEmpty("serverDomain", serverDomain)
        try ServerShare.checkShareId(shareId)
        try ServerShare.checkHex64("tokenHash", tokenHash)
        try ServerShare.checkHex64("offerSha256", offerSha256)
        try ServerShare.checkHex64("ownerSha256", ownerSha256)
        try ServerShare.time("expiresAt", expiresAt)
        try ServerShare.time("issuedAt", issuedAt)
        return ServerShare.join(ServerShare.tagOffer, [
            username, serverDomain, shareId, tokenHash, offerSha256, ownerSha256,
            String(expiresAt), String(issuedAt),
        ])
    }
}

/// #7 — signed by A; lists A's offer rows.
public struct ServerShareList: ServerShareEnvelope {
    public var username: String
    public var issuedAt: Int64

    public init(username: String, issuedAt: Int64) {
        self.username = username
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("username", username)
        try ServerShare.time("issuedAt", issuedAt)
        return ServerShare.join(ServerShare.tagList, [username, String(issuedAt)])
    }
}

/// #8 — signed by A's sensitive key; puts or withdraws B's boot copy.
public struct ServerShareUnlock: ServerShareEnvelope {
    public var serverDomain: String
    public var shareId: String
    public var memberPubHex: String
    /// SHA-256 hex of the sealed copy's hex, or `off`.
    public var sealedSha256: String
    public var issuedAt: Int64

    public init(serverDomain: String, shareId: String, memberPubHex: String, sealedSha256: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.shareId = shareId
        self.memberPubHex = memberPubHex
        self.sealedSha256 = sealedSha256
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("serverDomain", serverDomain)
        try ServerShare.checkShareId(shareId)
        try ServerShare.checkHex64("memberPubHex", memberPubHex)
        if sealedSha256 != ServerShare.unlockOff { try ServerShare.checkHex64("sealedSha256", sealedSha256) }
        try ServerShare.time("issuedAt", issuedAt)
        return ServerShare.join(ServerShare.tagUnlock, [serverDomain, shareId, memberPubHex, sealedSha256, String(issuedAt)])
    }
}

/// #9 — signed by B's inbox key.
public struct ShareInboxRequest: ServerShareEnvelope {
    public var inboxPubHex: String
    public var op: ShareInboxOp
    /// 32 hex, or "" for `list`.
    public var entryId: String
    /// SHA-256 hex of the entry ciphertext's hex for `put`, else "".
    public var ctSha256: String
    public var issuedAt: Int64

    public init(inboxPubHex: String, op: ShareInboxOp, entryId: String, ctSha256: String, issuedAt: Int64) {
        self.inboxPubHex = inboxPubHex
        self.op = op
        self.entryId = entryId
        self.ctSha256 = ctSha256
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.checkHex64("inboxPubHex", inboxPubHex)
        if op == .list {
            if !entryId.isEmpty { throw ServerShareError.invalid("share-inbox: list takes no entryId") }
        } else if !ServerShare.isLowerHex(entryId, 32) {
            throw ServerShareError.invalid("share-inbox: entryId must be 32 lowercase hex")
        }
        if op == .put {
            try ServerShare.checkHex64("ctSha256", ctSha256)
        } else if !ctSha256.isEmpty {
            throw ServerShareError.invalid("share-inbox: only put carries ctSha256")
        }
        try ServerShare.time("issuedAt", issuedAt)
        return ServerShare.join(ServerShare.tagInbox, [inboxPubHex, op.rawValue, entryId, ctSha256, String(issuedAt)])
    }
}

/// #10 — signed by B's member key; registers (or drops) one device's push
/// token for this share's start-up approvals.
public struct ServerSharePush: ServerShareEnvelope {
    public var serverDomain: String
    public var shareId: String
    public var memberPubHex: String
    public var op: SharePushOp
    public var platform: SharePushPlatform
    /// SHA-256 hex of the provider token's UTF-8 bytes.
    public var tokenSha256: String
    public var issuedAt: Int64

    public init(serverDomain: String, shareId: String, memberPubHex: String, op: SharePushOp,
                platform: SharePushPlatform, tokenSha256: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.shareId = shareId
        self.memberPubHex = memberPubHex
        self.op = op
        self.platform = platform
        self.tokenSha256 = tokenSha256
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("serverDomain", serverDomain)
        try ServerShare.checkShareId(shareId)
        try ServerShare.checkHex64("memberPubHex", memberPubHex)
        try ServerShare.checkHex64("tokenSha256", tokenSha256)
        try ServerShare.time("issuedAt", issuedAt)
        return ServerShare.join(ServerShare.tagPush, [
            serverDomain, shareId, memberPubHex, op.rawValue, platform.rawValue, tokenSha256, String(issuedAt),
        ])
    }
}

/// #11 — signed by B's member key at manage level: move the server to an
/// endorsed release. The box applies it through the owner's update gates.
public struct ServerShareUpdate: ServerShareEnvelope {
    public var serverDomain: String
    public var shareId: String
    public var memberPubHex: String
    public var targetCommit: String
    public var fromCommit: String
    /// 64 hex, single use.
    public var nonce: String
    public var issuedAt: Int64

    public init(serverDomain: String, shareId: String, memberPubHex: String, targetCommit: String,
                fromCommit: String, nonce: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.shareId = shareId
        self.memberPubHex = memberPubHex
        self.targetCommit = targetCommit
        self.fromCommit = fromCommit
        self.nonce = nonce
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServerShare.nonEmpty("serverDomain", serverDomain)
        try ServerShare.checkShareId(shareId)
        try ServerShare.checkHex64("memberPubHex", memberPubHex)
        try ServerShare.checkCommit("targetCommit", targetCommit)
        try ServerShare.checkCommit("fromCommit", fromCommit)
        try ServerShare.checkHex64("nonce", nonce)
        try ServerShare.time("issuedAt", issuedAt)
        return ServerShare.join(ServerShare.tagUpdate, [
            serverDomain, shareId, memberPubHex, targetCommit, fromCommit, nonce, String(issuedAt),
        ])
    }
}

// MARK: - Sealed payloads

/// Sealed under the link key, AAD `aadOffer|<shareId>`.
public struct ShareOfferPayload: Equatable, Sendable {
    public var serverDomain: String
    /// A's short name for the server, as A's app shows it.
    public var serverName: String
    /// The box STK, so B seals boot approvals only for it (.com can't swap it).
    public var stkPubHex: String
    public var level: ServerShareLevel
    public var unlockAtBoot: Bool
    public var seeAppData: Bool
    public var expiresAt: Int64

    public init(serverDomain: String, serverName: String, stkPubHex: String, level: ServerShareLevel,
                unlockAtBoot: Bool, seeAppData: Bool, expiresAt: Int64) {
        self.serverDomain = serverDomain
        self.serverName = serverName
        self.stkPubHex = stkPubHex
        self.level = level
        self.unlockAtBoot = unlockAtBoot
        self.seeAppData = seeAppData
        self.expiresAt = expiresAt
    }

    public init?(jsonObject v: Any) {
        guard let o = v as? [String: Any], ServerShare.jsonIsOne(o["v"]),
              let serverDomain = o["serverDomain"] as? String, !serverDomain.isEmpty,
              let serverName = o["serverName"] as? String,
              let stk = o["stkPubHex"] as? String, ServerShare.isLowerHex(stk, 64),
              let lv = o["level"] as? String, let level = ServerShareLevel(rawValue: lv),
              let unlockAtBoot = ServerShare.jsonBool(o["unlockAtBoot"]),
              let seeAppData = ServerShare.jsonBool(o["seeAppData"]),
              let expiresAt = ServerShare.jsonTime(o["expiresAt"])
        else { return nil }
        self.init(serverDomain: serverDomain, serverName: serverName, stkPubHex: stk, level: level,
                  unlockAtBoot: unlockAtBoot, seeAppData: seeAppData, expiresAt: expiresAt)
    }

    /// The plaintext, keyed in the same order as the TS `JSON.stringify`.
    public func jsonData() -> Data {
        let j = ServerShare.jsonString
        return Data(("{\"v\":1,\"serverDomain\":\(j(serverDomain)),\"serverName\":\(j(serverName))," +
            "\"stkPubHex\":\(j(stkPubHex)),\"level\":\(j(level.rawValue)),\"unlockAtBoot\":\(unlockAtBoot)," +
            "\"seeAppData\":\(seeAppData),\"expiresAt\":\(expiresAt)}").utf8)
    }
}

/// Sealed under A's household key, AAD `aadOwner|<shareId>`.
public struct ShareOwnerRecord: Equatable, Sendable {
    public var secretHex: String
    public var label: String
    public var level: ServerShareLevel
    public var unlockAtBoot: Bool
    public var seeAppData: Bool

    public init(secretHex: String, label: String, level: ServerShareLevel, unlockAtBoot: Bool, seeAppData: Bool) {
        self.secretHex = secretHex
        self.label = label
        self.level = level
        self.unlockAtBoot = unlockAtBoot
        self.seeAppData = seeAppData
    }

    public init?(jsonObject v: Any) {
        guard let o = v as? [String: Any], ServerShare.jsonIsOne(o["v"]),
              let secretHex = o["secretHex"] as? String, ServerShare.isLowerHex(secretHex, 64),
              let label = o["label"] as? String, ServerShare.normalizeShareLabel(label) != nil,
              let lv = o["level"] as? String, let level = ServerShareLevel(rawValue: lv),
              let unlockAtBoot = ServerShare.jsonBool(o["unlockAtBoot"]),
              let seeAppData = ServerShare.jsonBool(o["seeAppData"])
        else { return nil }
        self.init(secretHex: secretHex, label: label, level: level, unlockAtBoot: unlockAtBoot, seeAppData: seeAppData)
    }

    public func jsonData() -> Data {
        let j = ServerShare.jsonString
        return Data(("{\"v\":1,\"secretHex\":\(j(secretHex)),\"label\":\(j(label)),\"level\":\(j(level.rawValue))," +
            "\"unlockAtBoot\":\(unlockAtBoot),\"seeAppData\":\(seeAppData)}").utf8)
    }
}

/// Sealed under the link key, AAD `aadAcceptance|<shareId>`.
public struct ShareAcceptancePayload: Equatable, Sendable {
    public var accept: ServerShareAccept
    public var signature: String
    /// The joining account's admin proof (§5.1); absent only from an older app,
    /// and then the shared server refuses the share.
    public var admin: ShareAcceptAdminProof?

    public init(accept: ServerShareAccept, signature: String, admin: ShareAcceptAdminProof? = nil) {
        self.accept = accept
        self.signature = signature
        self.admin = admin
    }

    public init?(jsonObject v: Any) {
        guard let o = v as? [String: Any], ServerShare.jsonIsOne(o["v"]),
              let signature = o["signature"] as? String, ServerShare.isLowerHex(signature, 128),
              let a = o["accept"] as? [String: Any],
              let serverDomain = a["serverDomain"] as? String,
              let shareId = a["shareId"] as? String,
              let memberPubHex = a["memberPubHex"] as? String,
              let acceptedAt = ServerShare.jsonTime(a["acceptedAt"])
        else { return nil }
        let accept = ServerShareAccept(serverDomain: serverDomain, shareId: shareId, memberPubHex: memberPubHex, acceptedAt: acceptedAt)
        guard (try? accept.canonicalBytes()) != nil else { return nil }
        var admin: ShareAcceptAdminProof?
        if let raw = o["admin"] {
            guard let proof = ShareAcceptAdminProof(jsonObject: raw) else { return nil }
            admin = proof
        }
        self.init(accept: accept, signature: signature, admin: admin)
    }

    public func jsonData() -> Data {
        let j = ServerShare.jsonString
        var out = "{\"v\":1,\"accept\":{\"serverDomain\":" + j(accept.serverDomain)
        out += ",\"shareId\":" + j(accept.shareId)
        out += ",\"memberPubHex\":" + j(accept.memberPubHex)
        out += ",\"acceptedAt\":" + String(accept.acceptedAt) + "}"
        out += ",\"signature\":" + j(signature)
        if let admin { out += ",\"admin\":" + admin.jsonFragment() }
        out += "}"
        return Data(out.utf8)
    }
}

/// Sealed under B's inbox seal key, AAD `aadInboxEntry|<entryId>`.
public struct ShareInboxEntry: Equatable, Sendable {
    public var shareId: String
    public var secretHex: String
    public var serverDomain: String
    public var serverName: String
    public var acceptedAt: Int64

    public init(shareId: String, secretHex: String, serverDomain: String, serverName: String, acceptedAt: Int64) {
        self.shareId = shareId
        self.secretHex = secretHex
        self.serverDomain = serverDomain
        self.serverName = serverName
        self.acceptedAt = acceptedAt
    }

    public init?(jsonObject v: Any) {
        guard let o = v as? [String: Any], ServerShare.jsonIsOne(o["v"]),
              let shareId = o["shareId"] as? String, ServerShare.isLowerHex(shareId, 32),
              let secretHex = o["secretHex"] as? String, ServerShare.isLowerHex(secretHex, 64),
              let serverDomain = o["serverDomain"] as? String,
              let serverName = o["serverName"] as? String,
              let acceptedAt = ServerShare.jsonTime(o["acceptedAt"])
        else { return nil }
        self.init(shareId: shareId, secretHex: secretHex, serverDomain: serverDomain, serverName: serverName, acceptedAt: acceptedAt)
    }

    public func jsonData() -> Data {
        let j = ServerShare.jsonString
        return Data(("{\"v\":1,\"shareId\":\(j(shareId)),\"secretHex\":\(j(secretHex)),\"serverDomain\":\(j(serverDomain))," +
            "\"serverName\":\(j(serverName)),\"acceptedAt\":\(acceptedAt)}").utf8)
    }
}
