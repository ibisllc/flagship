import Foundation

/// The owner takes their voi.ci page down (docs/voici-and-messages.md §3.3 "Remove my page"). Swift twin of
/// packages/protocol/src/voiciPageRemove.ts, pinned by packages/protocol/test-vectors/voici-page-remove/vectors.json.
///
///   flagship/voici-page-remove/v1|<username lowercase>|<pageId>|<seq>|<issuedAt ms>
///
/// Ed25519 by the key that signs the page index (admin root; the IRK only when the account pins none). `seq` climbs the
/// publish ladder (stored seq + 1), so neither an old public index nor the removal can be replayed.
public struct VoiciPageRemove: Equatable, Sendable {
    public enum Refusal: String, Sendable {
        case malformed, wrongPage = "wrong-page", seqConflict = "seq-conflict", stale, badSignature = "bad-signature", wrongSigner = "wrong-signer"
    }

    public var username: String
    public var pageId: String
    public var seq: Int64
    public var issuedAt: Int64
    /// "admin-root" or "irk".
    public var signerKind: String
    public var signerPub: String
    public var signature: String

    public init(username: String, pageId: String, seq: Int64, issuedAt: Int64, signerKind: String, signerPub: String = "", signature: String = "") {
        self.username = username; self.pageId = pageId; self.seq = seq; self.issuedAt = issuedAt
        self.signerKind = signerKind; self.signerPub = signerPub; self.signature = signature
    }

    /// The signed envelope, the body of `POST /api/voici/pages/<u>/remove`.
    public var json: JSONValue {
        ["kind": "VoiciPageRemove", "version": 1, "username": .string(username), "pageId": .string(pageId), "seq": .int(seq),
         "issuedAt": .int(issuedAt), "signerKind": .string(signerKind), "signerPub": .string(signerPub), "signature": .string(signature)]
    }

    public static let tag = "flagship/voici-page-remove/v1"
    static let keys: Set<String> = ["kind", "version", "username", "pageId", "seq", "issuedAt", "signerKind", "signerPub", "signature"]

    public static func canonical(username: String, pageId: String, seq: Int64, issuedAt: Int64) throws -> [UInt8] {
        guard VoiciPage.isUsername(username) else { throw CanonicalJsonError("\(tag): bad username") }
        guard VoiciPage.isPageId(pageId) else { throw CanonicalJsonError("\(tag): bad pageId") }
        guard CanonicalJson.isTime(seq), seq >= 1, CanonicalJson.isTime(issuedAt) else { throw CanonicalJsonError("\(tag): bad seq/issuedAt") }
        return CanonicalJson.join([tag, username, pageId, String(seq), String(issuedAt)])
    }

    /// Signs with the sensitive key's seed; signerPub is its public key.
    public static func sign(username: String, pageId: String, seq: Int64, issuedAt: Int64, signerKind: String, signerSeed: [UInt8]) throws -> VoiciPageRemove {
        guard signerKind == "admin-root" || signerKind == "irk" else { throw CanonicalJsonError("\(tag): bad signerKind") }
        let bytes = try canonical(username: username, pageId: pageId, seq: seq, issuedAt: issuedAt)
        return VoiciPageRemove(username: username, pageId: pageId, seq: seq, issuedAt: issuedAt, signerKind: signerKind,
                               signerPub: CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: signerSeed)),
                               signature: try CanonicalJson.ed25519SignHex(bytes, seed: signerSeed))
    }

    /// Strict shape of an untrusted removal; no signature check.
    public static func parse(_ input: JSONValue) -> VoiciPageRemove? {
        var v = input
        if case .string(let text) = input {
            guard text.utf8.count <= 4096, let p = JSONValue.parse(text) else { return nil }
            v = p
        }
        guard let r = v.object, Set(r.keys) == keys, r["kind"]?.string == "VoiciPageRemove", r["version"]?.isOne == true,
              let kind = r["signerKind"]?.string, kind == "admin-root" || kind == "irk",
              CanonicalJson.isLowerHex(r["signerPub"], bytes: 32), CanonicalJson.isLowerHex(r["signature"], bytes: 64),
              let username = r["username"]?.string, let pageId = r["pageId"]?.string,
              let seq = r["seq"]?.safeInt, let issuedAt = r["issuedAt"]?.safeInt,
              (try? canonical(username: username, pageId: pageId, seq: seq, issuedAt: issuedAt)) != nil else { return nil }
        return VoiciPageRemove(username: username, pageId: pageId, seq: seq, issuedAt: issuedAt, signerKind: kind,
                               signerPub: r["signerPub"]!.string!, signature: r["signature"]!.string!)
    }

    /// `.com`'s check (the apps run it only against the shared vectors): malformed, wrong-signer, bad-signature,
    /// wrong-page, stale, seq-conflict.
    public static func check(_ input: JSONValue, username: String, sensitiveKind: String, sensitivePub: String,
                             storedSeq: Int64, storedPageId: String?, now: Int64) -> VoiciVerdict<VoiciPageRemove, Refusal> {
        guard let r = parse(input), r.username == username else { return .refused(.malformed) }
        if r.signerKind != sensitiveKind || r.signerPub != sensitivePub.lowercased() { return .refused(.wrongSigner) }
        guard let bytes = try? canonical(username: r.username, pageId: r.pageId, seq: r.seq, issuedAt: r.issuedAt),
              CanonicalJson.ed25519VerifyHex(r.signature, bytes, r.signerPub) else { return .refused(.badSignature) }
        guard let stored = storedPageId, stored == r.pageId else { return .refused(.wrongPage) }
        if abs(r.issuedAt - now) > VoiciPage.indexSkewMs { return .refused(.stale) }
        if r.seq != storedSeq + 1 { return .refused(.seqConflict) }
        return .ok(r)
    }
}
