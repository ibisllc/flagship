import Foundation

/// Ringing a caller back (docs/voici-calls.md "Who may call a page, and ringing a caller back"): the page owner's
/// signed ring into a conversation whose caller chose "Call and allow call-back", and the hint sealed to the caller's
/// thread key that tells only the caller's own app which page is calling. Swift twin of the ring section of
/// packages/protocol/src/voiciCallModes.ts (vectors: section `ring` of test-vectors/voici-call-modes/vectors.json).
///
///   ring  flagship/voici-ring/v1|<pageId>|<conv>|<ringId>|<H(hint bytes)>|<media>|<issuedAt>   Ed25519 by ownerSignPub
///   hint  flagship/hybrid-seal/v1, purpose "flagship/voici-ring-hint/v1", context [conv, ringId], to the thread key T;
///         plaintext canonical JSON {v:1, pageId, username, conv, ringId, media, issuedAt}
public struct VoiciRingHint: Equatable, Sendable {
    public let pageId: String
    public let username: String
    public let conv: String
    public let ringId: String
    public let media: String
    public let issuedAt: Int64
    public init(pageId: String, username: String, conv: String, ringId: String, media: String, issuedAt: Int64) {
        self.pageId = pageId; self.username = username; self.conv = conv; self.ringId = ringId; self.media = media; self.issuedAt = issuedAt
    }
}

public enum VoiciRings {
    public static let tagRing = "flagship/voici-ring/v1"
    public static let tagHint = "flagship/voici-ring-hint/v1"
    /// A ring lasts as long as an incoming call rings.
    public static let ttlMs: Int64 = 45_000

    private static func fieldsOk(pageId: String, conv: String, ringId: String, media: String, issuedAt: Int64) -> Bool {
        VoiciCalls.isPageId(pageId) && CanonicalJson.isLowerHex(conv, bytes: 32) && CanonicalJson.isLowerHex(ringId, bytes: 16)
            && VoiciCalls.mediaValues.contains(media) && CanonicalJson.isTime(issuedAt)
    }

    public static func sealHint(threadPub: [UInt8], _ h: VoiciRingHint, eseed: [UInt8]? = nil) throws -> [UInt8] {
        guard fieldsOk(pageId: h.pageId, conv: h.conv, ringId: h.ringId, media: h.media, issuedAt: h.issuedAt), VoiciCalls.isUsername(h.username)
        else { throw CanonicalJsonError("\(tagHint): bad field") }
        let plain: JSONValue = ["v": 1, "pageId": .string(h.pageId), "username": .string(h.username), "conv": .string(h.conv),
                                "ringId": .string(h.ringId), "media": .string(h.media), "issuedAt": .number(Double(h.issuedAt))]
        return try PqHybrid.hybridSealWithRandomness(
            recipientPublicKey: threadPub, options: HybridSealOptions(purpose: tagHint, senderKeyId: [UInt8](repeating: 0, count: 32), issuedAt: UInt64(h.issuedAt)),
            context: [Array(h.conv.utf8), Array(h.ringId.utf8)], plaintext: try CanonicalJson.canonicalJsonBytes(plain),
            eseed: eseed ?? (0..<PqHybrid.sealRandomnessLen).map { _ in UInt8.random(in: 0...255) })
    }

    /// The caller's app: the hint, when it opens under this thread key for this conversation and ring and names them.
    public static func openHint(threadSeed: [UInt8], conv: String, ringId: String, sealed: [UInt8]) -> VoiciRingHint? {
        guard let opened = try? PqHybrid.hybridOpen(recipientSecretKey: threadSeed, expectedPurpose: tagHint,
                                                    context: [Array(conv.utf8), Array(ringId.utf8)], sealed: sealed),
              let v = JSONValue.parse(utf8: opened.plaintext)?.object,
              Set(v.keys) == ["v", "pageId", "username", "conv", "ringId", "media", "issuedAt"], v["v"]?.isOne == true,
              v["conv"]?.string == conv, v["ringId"]?.string == ringId, let p = v["pageId"]?.string, let u = v["username"]?.string,
              let m = v["media"]?.string, let at = v["issuedAt"]?.time,
              fieldsOk(pageId: p, conv: conv, ringId: ringId, media: m, issuedAt: at), VoiciCalls.isUsername(u) else { return nil }
        return VoiciRingHint(pageId: p, username: u, conv: conv, ringId: ringId, media: m, issuedAt: at)
    }

    public static func canonicalRing(pageId: String, conv: String, ringId: String, hint: String, media: String, issuedAt: Int64) throws -> [UInt8] {
        guard fieldsOk(pageId: pageId, conv: conv, ringId: ringId, media: media, issuedAt: issuedAt) else { throw CanonicalJsonError("\(tagRing): bad field") }
        return CanonicalJson.join([tagRing, pageId, conv, ringId, CanonicalJson.sha256Hex(CanonicalJson.b64Decode(hint) ?? []), media, String(issuedAt)])
    }

    /// The owner's ring `{ring, signature}` for `POST /api/voici/rings/<ringId>`.
    public static func signedRing(pageId: String, conv: String, ringId: String, hint: String, media: String, issuedAt: Int64,
                                  ownerSignSeed: [UInt8]) throws -> (ring: JSONValue, signature: String) {
        let sig = try CanonicalJson.ed25519SignHex(try canonicalRing(pageId: pageId, conv: conv, ringId: ringId, hint: hint, media: media, issuedAt: issuedAt),
                                                   seed: ownerSignSeed)
        return (["pageId": .string(pageId), "conv": .string(conv), "ringId": .string(ringId), "hint": .string(hint), "media": .string(media),
                 "issuedAt": .number(Double(issuedAt))], sig)
    }

    public static func verifyRing(_ ring: JSONValue, signature: String, ownerSignPub: String) -> Bool {
        guard let r = ring.object, Set(r.keys) == ["pageId", "conv", "ringId", "hint", "media", "issuedAt"], let p = r["pageId"]?.string,
              let c = r["conv"]?.string, let id = r["ringId"]?.string, let h = r["hint"]?.string, let m = r["media"]?.string, let at = r["issuedAt"]?.time,
              CanonicalJson.isLowerHex(signature, bytes: 64), let bytes = try? canonicalRing(pageId: p, conv: c, ringId: id, hint: h, media: m, issuedAt: at)
        else { return false }
        return CanonicalJson.ed25519VerifyHex(signature, bytes, ownerSignPub)
    }

    // MARK: the ring-back channel (the caller's side)

    public static let tagRingBack = "flagship/voici-ring-back/v1"

    public static func canonicalRingBack(pageId: String, conv: String, op: String, issuedAt: Int64) throws -> [UInt8] {
        guard VoiciCalls.isPageId(pageId), CanonicalJson.isLowerHex(conv, bytes: 32), op == "attach" || op == "stop", CanonicalJson.isTime(issuedAt)
        else { throw CanonicalJsonError("\(tagRingBack): bad field") }
        return CanonicalJson.join([tagRingBack, pageId, conv, op, String(issuedAt)])
    }

    /// The visitor's app attaches (or stops) the conversation's ring-back channel, signed by its pseudonym P:
    /// `{order, signer:"pseudonym", from, sig}` for `POST /api/voici/web/ring-back` with device headers.
    public static func signedRingBack(pageId: String, conv: String, op: String, issuedAt: Int64, pseudonymSeed: [UInt8]) throws -> JSONValue {
        let from = CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: pseudonymSeed))
        let sig = try CanonicalJson.ed25519SignHex(try canonicalRingBack(pageId: pageId, conv: conv, op: op, issuedAt: issuedAt), seed: pseudonymSeed)
        return ["order": ["pageId": .string(pageId), "conv": .string(conv), "op": .string(op), "issuedAt": .number(Double(issuedAt))],
                "signer": "pseudonym", "from": .string(from), "sig": .string(sig)]
    }
}
