import Foundation

/// A conversation's end and its one disclosure (docs/voici-calls.md "Deleting a conversation, and revealing who you
/// are", "What the reveal shows"). Swift twin of packages/protocol/src/voiciConversation.ts (vectors:
/// test-vectors/voici-conversation/vectors.json).
///
///   delete   flagship/voici-conv-delete/v1|<pageId>|<conv>|<owner|caller>|<issuedAt>   owner: Ed25519 by ownerSignPub;
///            caller: Ed25519 by the pseudonym P. `.com` drops the conversation's mailbox, channel, ring and missed calls.
///   reveal   flagship/voici-reveal/v1|<conv>|<username>|<SHA-256 hex of the display name, or "-">|<issuedAt>   Ed25519 by
///            the caller's own page key; sent inside the conversation as a message body {v:1, control:<reveal>}.
///   unreveal {v:1, kind:"voici-unreveal", conv, issuedAt} as {v:1, control:<unreveal>}.
public struct VoiciReveal: Equatable, Sendable {
    public let conv: String
    public let username: String
    public let displayName: String?
    public let issuedAt: Int64
    public let sig: String
}

public enum VoiciConversations {
    public static let tagDelete = "flagship/voici-conv-delete/v1"
    public static let tagReveal = "flagship/voici-reveal/v1"
    public static let skewMs: Int64 = 10 * 60_000

    // MARK: delete = forget

    public static func canonicalDelete(pageId: String, conv: String, side: String, issuedAt: Int64) throws -> [UInt8] {
        // A signed-in conversation is 32 bytes; an anonymous caller's is 16 (VoiciCallModes.anonConv).
        guard VoiciCalls.isPageId(pageId), CanonicalJson.isLowerHex(conv, bytes: 32) || CanonicalJson.isLowerHex(conv, bytes: 16),
              side == "owner" || side == "caller", CanonicalJson.isTime(issuedAt)
        else { throw CanonicalJsonError("\(tagDelete): bad field") }
        return CanonicalJson.join([tagDelete, pageId, conv, side, String(issuedAt)])
    }

    private static func del(_ pageId: String, _ conv: String, _ side: String, _ at: Int64) -> JSONValue {
        ["pageId": .string(pageId), "conv": .string(conv), "issuedAt": .number(Double(at)), "side": .string(side)]
    }

    /// The page owner's delete `{del, signer:"owner", sig}`.
    public static func signedDeleteOwner(pageId: String, conv: String, issuedAt: Int64, ownerSignSeed: [UInt8]) throws -> JSONValue {
        let sig = try CanonicalJson.ed25519SignHex(try canonicalDelete(pageId: pageId, conv: conv, side: "owner", issuedAt: issuedAt), seed: ownerSignSeed)
        return ["del": del(pageId, conv, "owner", issuedAt), "signer": "owner", "sig": .string(sig)]
    }

    /// The caller's delete from its app `{del, signer:"pseudonym", from, sig}`.
    public static func signedDeleteCaller(pageId: String, conv: String, issuedAt: Int64, pseudonymSeed: [UInt8]) throws -> JSONValue {
        let from = CanonicalJson.hex(try CanonicalJson.ed25519PublicKey(seed: pseudonymSeed))
        let sig = try CanonicalJson.ed25519SignHex(try canonicalDelete(pageId: pageId, conv: conv, side: "caller", issuedAt: issuedAt), seed: pseudonymSeed)
        return ["del": del(pageId, conv, "caller", issuedAt), "signer": "pseudonym", "from": .string(from), "sig": .string(sig)]
    }

    // MARK: blocking an anonymous caller

    public static let tagAnonBlock = "flagship/voici-anon-block/v1"

    /// `flagship/voici-anon-block/v1|<pageId>|<conv (16 bytes)>|<block|unblock>|<issuedAt>`, Ed25519 by ownerSignPub: an
    /// anonymous caller's conversation can't call again until the owner unblocks it or deletes the conversation.
    public static func canonicalAnonBlock(pageId: String, conv: String, op: String, issuedAt: Int64) throws -> [UInt8] {
        guard VoiciCalls.isPageId(pageId), CanonicalJson.isLowerHex(conv, bytes: 16), op == "block" || op == "unblock", CanonicalJson.isTime(issuedAt)
        else { throw CanonicalJsonError("\(tagAnonBlock): bad field") }
        return CanonicalJson.join([tagAnonBlock, pageId, conv, op, String(issuedAt)])
    }

    /// `{block, signature}` for `POST /api/voici/pages/<u>/anon-block`.
    public static func signedAnonBlock(pageId: String, conv: String, op: String, issuedAt: Int64, ownerSignSeed: [UInt8]) throws -> JSONValue {
        let sig = try CanonicalJson.ed25519SignHex(try canonicalAnonBlock(pageId: pageId, conv: conv, op: op, issuedAt: issuedAt), seed: ownerSignSeed)
        return ["block": ["pageId": .string(pageId), "conv": .string(conv), "op": .string(op), "issuedAt": .number(Double(issuedAt))], "signature": .string(sig)]
    }

    public static func verifyAnonBlock(_ block: JSONValue?, signature: String, ownerSignPub: String) -> Bool {
        guard let b = block?.object, Set(b.keys) == ["pageId", "conv", "op", "issuedAt"], let p = b["pageId"]?.string, let c = b["conv"]?.string,
              let op = b["op"]?.string, let at = b["issuedAt"]?.time, CanonicalJson.isLowerHex(signature, bytes: 64),
              let bytes = try? canonicalAnonBlock(pageId: p, conv: c, op: op, issuedAt: at) else { return false }
        return CanonicalJson.ed25519VerifyHex(signature, bytes, ownerSignPub)
    }

    // MARK: reveal who I am

    public static func revealNameHash(_ displayName: String?) -> String { displayName.map { CanonicalJson.sha256Hex($0) } ?? "-" }

    public static func canonicalReveal(conv: String, username: String, displayName: String?, issuedAt: Int64) throws -> [UInt8] {
        guard CanonicalJson.isLowerHex(conv, bytes: 32), VoiciCalls.isUsername(username), CanonicalJson.isTime(issuedAt) else {
            throw CanonicalJsonError("\(tagReveal): bad field")
        }
        if let d = displayName, VoiciText.checkVoiciText(.displayName, d) != nil { throw CanonicalJsonError("\(tagReveal): bad display name") }
        return CanonicalJson.join([tagReveal, conv, username, revealNameHash(displayName), String(issuedAt)])
    }

    /// The caller's reveal, signed by its own page's key; the wire record a `{v:1, control}` body carries.
    public static func signedReveal(conv: String, username: String, displayName: String?, issuedAt: Int64, pageSignSeed: [UInt8]) throws -> JSONValue {
        let sig = try CanonicalJson.ed25519SignHex(try canonicalReveal(conv: conv, username: username, displayName: displayName, issuedAt: issuedAt),
                                                   seed: pageSignSeed)
        return ["v": 1, "kind": "voici-reveal", "conv": .string(conv), "username": .string(username),
                "displayName": displayName.map { .string($0) } ?? .null, "issuedAt": .number(Double(issuedAt)), "sig": .string(sig)]
    }

    public static func unreveal(conv: String, issuedAt: Int64) -> JSONValue {
        ["v": 1, "kind": "voici-unreveal", "conv": .string(conv), "issuedAt": .number(Double(issuedAt))]
    }

    /// The message body that carries a reveal or an unreveal inside the sealed conversation.
    public static func controlBody(_ control: JSONValue) -> JSONValue { ["v": 1, "control": control] }

    public enum Control: Equatable, Sendable {
        case reveal(VoiciReveal)
        case unreveal(conv: String, issuedAt: Int64)
    }

    /// Strict shape of a reveal or an unreveal; nil otherwise.
    public static func parseControl(_ v: JSONValue?) -> Control? {
        guard let r = v?.object, r["v"]?.isOne == true else { return nil }
        if r["kind"]?.string == "voici-unreveal" {
            guard Set(r.keys) == ["v", "kind", "conv", "issuedAt"], let c = r["conv"]?.string, CanonicalJson.isLowerHex(c, bytes: 32), let at = r["issuedAt"]?.time
            else { return nil }
            return .unreveal(conv: c, issuedAt: at)
        }
        guard r["kind"]?.string == "voici-reveal", Set(r.keys) == ["v", "kind", "conv", "username", "displayName", "issuedAt", "sig"],
              let sig = r["sig"]?.string, CanonicalJson.isLowerHex(sig, bytes: 64), let c = r["conv"]?.string, let u = r["username"]?.string,
              let at = r["issuedAt"]?.time, let dn = r["displayName"] else { return nil }
        let name: String?
        switch dn {
        case .null: name = nil
        case .string(let s): name = s
        default: return nil
        }
        guard (try? canonicalReveal(conv: c, username: u, displayName: name, issuedAt: at)) != nil else { return nil }
        return .reveal(VoiciReveal(conv: c, username: u, displayName: name, issuedAt: at, sig: sig))
    }

    public enum RevealRefusal: String, Sendable { case malformed, wrongConv = "wrong-conv", badSignature = "bad-signature" }

    /// The owner's app: a reveal for this conversation, signed by the page key `.com` serves for its username.
    public static func checkReveal(_ v: JSONValue?, conv: String, pageSignPub: String) -> VoiciVerdict<VoiciReveal, RevealRefusal> {
        guard case .reveal(let r) = parseControl(v), let bytes = try? canonicalReveal(conv: r.conv, username: r.username, displayName: r.displayName, issuedAt: r.issuedAt)
        else { return .refused(.malformed) }
        if r.conv != conv { return .refused(.wrongConv) }
        return CanonicalJson.ed25519VerifyHex(r.sig, bytes, pageSignPub) ? .ok(r) : .refused(.badSignature)
    }

    /// The pill on the owner's side: "Display Name (username)", or the username alone.
    public static func pillText(_ r: VoiciReveal) -> String {
        r.displayName.map { "\($0) (\(r.username))" } ?? r.username
    }
}
