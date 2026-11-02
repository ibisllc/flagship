import Foundation

/// `flagship/web-envelope/v1`: the signed envelope voi.ci and the apps send to a Flagship API
/// (docs/voici-and-messages.md §7.1). Swift twin of packages/protocol/src/webEnvelope.ts, pinned by
/// packages/protocol/test-vectors/messages/vectors.json (`message`, `reply`, `draft`).
///
///   wire  {v:1, kind, audience, conv, from, msgId, seq, sentAt, bodyB64, cred, sigAlg, sig}
///   bytes flagship/web-envelope/v1|<kind>|<audience>|<conv>|<from>|<msgId>|<seq>|<sentAt>|<H(body)>|<H(canonicalJson(cred))>
///
/// Public API: WebEnvelope (struct, `json`), WebEnvelope.SigAlg, tagWebEnvelope, maxBytes, maxBodyBytes,
/// canonicalWebEnvelope, parseWebEnvelope, signWebEnvelopeEd25519, verifyWebEnvelopeSignature,
/// p256VerifyP1363, ed25519VerifyHex (the last two forward to CanonicalJson). P-256 signing happens in the
/// browser (WebCrypto); the app only verifies.
public struct WebEnvelope: Equatable, Sendable {
    public enum SigAlg: String, Sendable { case ed25519, p256 }

    public static let tagWebEnvelope = "flagship/web-envelope/v1"
    /// Whole envelope JSON, UTF-8 (voici-message and voici-reply).
    public static let maxBytes = 64 * 1024
    /// Decoded body (voici-message and voici-reply).
    public static let maxBodyBytes = 24 * 1024

    public var kind: String
    public var audience: String
    public var conv: String
    public var from: String
    public var msgId: String
    public var seq: Int64
    public var sentAt: Int64
    public var bodyB64: String
    public var cred: [String: JSONValue]
    /// Nil only for an envelope not yet signed.
    public var sigAlg: SigAlg?
    public var sig: String

    public init(kind: String, audience: String, conv: String, from: String, msgId: String, seq: Int64, sentAt: Int64,
                bodyB64: String, cred: [String: JSONValue], sigAlg: SigAlg? = nil, sig: String = "") {
        self.kind = kind; self.audience = audience; self.conv = conv; self.from = from; self.msgId = msgId
        self.seq = seq; self.sentAt = sentAt; self.bodyB64 = bodyB64; self.cred = cred; self.sigAlg = sigAlg; self.sig = sig
    }

    /// The wire object.
    public var json: JSONValue {
        .object([
            "v": 1, "kind": .string(kind), "audience": .string(audience), "conv": .string(conv), "from": .string(from),
            "msgId": .string(msgId), "seq": .int(seq), "sentAt": .int(sentAt), "bodyB64": .string(bodyB64),
            "cred": .object(cred), "sigAlg": .string(sigAlg?.rawValue ?? ""), "sig": .string(sig),
        ])
    }

    static func isKind(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard (1...32).contains(u.count), (0x61...0x7a).contains(u[0]) else { return false }
        return u.dropFirst().allSatisfy { (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2d }
    }

    /// The signed bytes (sig and sigAlg are not part of them). Throws on a field that cannot be joined.
    public static func canonicalWebEnvelope(_ e: WebEnvelope) throws -> [UInt8] {
        guard isKind(e.kind) else { throw CanonicalJsonError("\(tagWebEnvelope): bad kind") }
        for (k, v) in [("audience", e.audience), ("conv", e.conv), ("from", e.from), ("msgId", e.msgId)] {
            try CanonicalJson.validateNoSepCtrl(k, v)
        }
        guard CanonicalJson.isTime(e.seq), e.seq >= 1 else { throw CanonicalJsonError("\(tagWebEnvelope): bad seq") }
        guard CanonicalJson.isTime(e.sentAt) else { throw CanonicalJsonError("\(tagWebEnvelope): bad sentAt") }
        guard let body = CanonicalJson.b64Decode(e.bodyB64) else { throw CanonicalJsonError("\(tagWebEnvelope): bodyB64 is not canonical base64") }
        let credHash = CanonicalJson.sha256Hex(try CanonicalJson.canonicalJsonBytes(.object(e.cred)))
        return CanonicalJson.join([tagWebEnvelope, e.kind, e.audience, e.conv, e.from, e.msgId, String(e.seq), String(e.sentAt),
                                   CanonicalJson.sha256Hex(body), credHash])
    }

    static let envelopeKeys: Set<String> = ["audience", "bodyB64", "conv", "cred", "from", "kind", "msgId", "sentAt", "seq", "sig", "sigAlg", "v"]

    static func isRouteField(_ v: JSONValue?) -> String? {
        guard let s = v?.string, s.utf16.count <= 256,
              s.utf8.allSatisfy({ (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2d }) else { return nil }
        return s
    }

    /// Strict outer shape of an untrusted envelope: a `.string` is JSON text, anything else an already parsed value.
    /// Exactly the wire keys, types, msgId 16 bytes of hex, a 64-byte hex signature, canonical base64 of at most
    /// `maxBodyBytes`, a cred that canonical JSON accepts. Kind-specific rules are the caller's. Nil when malformed.
    public static func parseWebEnvelope(_ input: JSONValue, maxBodyBytes: Int = WebEnvelope.maxBodyBytes) -> WebEnvelope? {
        var v = input
        if case .string(let text) = input {
            guard let p = JSONValue.parse(text) else { return nil }
            v = p
        } else if case .brokenString = input {
            return nil
        }
        guard let r = v.object, Set(r.keys) == envelopeKeys, r["v"]?.isOne == true,
              let kind = r["kind"]?.string, isKind(kind),
              let audience = isRouteField(r["audience"]), let conv = isRouteField(r["conv"]), let from = isRouteField(r["from"]),
              CanonicalJson.isLowerHex(r["msgId"], bytes: 16), let msgId = r["msgId"]?.string,
              let seq = r["seq"]?.time, seq >= 1, let sentAt = r["sentAt"]?.time,
              let bodyB64 = r["bodyB64"]?.string, let body = CanonicalJson.b64Decode(bodyB64), body.count <= maxBodyBytes,
              let cred = r["cred"]?.object, (try? CanonicalJson.canonicalJson(.object(cred))) != nil,
              let alg = r["sigAlg"]?.string.flatMap(SigAlg.init(rawValue:)),
              CanonicalJson.isLowerHex(r["sig"], bytes: 64), let sig = r["sig"]?.string else { return nil }
        return WebEnvelope(kind: kind, audience: audience, conv: conv, from: from, msgId: msgId, seq: seq, sentAt: sentAt,
                           bodyB64: bodyB64, cred: cred, sigAlg: alg, sig: sig)
    }

    /// Signs with an Ed25519 seed (randomized in CryptoKit: verify, never compare bytes).
    public static func signWebEnvelopeEd25519(_ e: WebEnvelope, seed: [UInt8]) throws -> WebEnvelope {
        var out = e
        out.sigAlg = .ed25519
        out.sig = try CanonicalJson.ed25519SignHex(try canonicalWebEnvelope(out), seed: seed)
        return out
    }

    /// Checks `sig` over the canonical bytes with `signerPub` (Ed25519 hex 64, or P-256 SEC1 uncompressed hex 130).
    public static func verifyWebEnvelopeSignature(_ e: WebEnvelope, signerPub: String) -> Bool {
        guard let bytes = try? canonicalWebEnvelope(e) else { return false }
        return e.sigAlg == .p256 ? p256VerifyP1363(e.sig, bytes, signerPub) : ed25519VerifyHex(e.sig, bytes, signerPub)
    }

    public static func p256VerifyP1363(_ sigHex: String, _ msg: [UInt8], _ pubHex: String) -> Bool {
        CanonicalJson.p256VerifyP1363(sigHex, msg, pubHex)
    }

    public static func ed25519VerifyHex(_ sigHex: String, _ msg: [UInt8], _ pubHex: String) -> Bool {
        CanonicalJson.ed25519VerifyHex(sigHex, msg, pubHex)
    }
}
