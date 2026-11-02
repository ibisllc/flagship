import Foundation

/// "Sign in with Flagship" delegations (docs/voici-and-messages.md §6.4): the per-page pseudonym key P (Ed25519) lets a
/// browser's WebCrypto P-256 key B sign for it, for one scope, origin and audience, until `expiresAt`. Swift twin of
/// packages/protocol/src/webDelegation.ts, pinned by packages/protocol/test-vectors/messages/vectors.json
/// (`delegation`).
///
///   flagship/web-delegation/v1|<scope>|<origin>|<audience>|<principalPub>|<delegateAlg>|<delegatePub>|<issuedAt>|<expiresAt>|<nonce>
///   flagship/web-delegation-revoke/v1|<delegatePub>|<issuedAt>
///
/// Public API: WebDelegation (struct, `json`), WebDelegation.Refusal, WebDelegationRevoke (struct, `json`),
/// WebDelegations namespace: tagWebDelegation, tagWebDelegationRevoke, scopes, voiciWebOrigin, voiciWebOriginGym,
/// canonicalWebDelegation, signWebDelegation, parseWebDelegation, checkWebDelegation, canonicalWebDelegationRevoke,
/// signWebDelegationRevoke, verifyWebDelegationRevoke, parseWebDelegationRevoke.
public struct WebDelegation: Equatable, Sendable {
    public enum Refusal: String, Sendable {
        case malformed, badSignature = "bad-signature", wrongScope = "wrong-scope", wrongOrigin = "wrong-origin"
        case wrongAudience = "wrong-audience", wrongPrincipal = "wrong-principal", notYetValid = "not-yet-valid"
        case expired, tooLong = "too-long"
    }

    public var scope: String
    public var origin: String
    public var audience: String
    public var principalPub: String
    public var delegateAlg: String
    public var delegatePub: String
    public var issuedAt: Int64
    public var expiresAt: Int64
    public var nonce: String

    public init(scope: String, origin: String, audience: String, principalPub: String, delegateAlg: String = "p256",
                delegatePub: String, issuedAt: Int64, expiresAt: Int64, nonce: String) {
        self.scope = scope; self.origin = origin; self.audience = audience; self.principalPub = principalPub
        self.delegateAlg = delegateAlg; self.delegatePub = delegatePub; self.issuedAt = issuedAt; self.expiresAt = expiresAt
        self.nonce = nonce
    }

    public var json: JSONValue {
        ["scope": .string(scope), "origin": .string(origin), "audience": .string(audience), "principalPub": .string(principalPub),
         "delegateAlg": .string(delegateAlg), "delegatePub": .string(delegatePub), "issuedAt": .int(issuedAt),
         "expiresAt": .int(expiresAt), "nonce": .string(nonce)]
    }
}

public struct WebDelegationRevoke: Equatable, Sendable {
    public var delegatePub: String
    public var issuedAt: Int64
    public init(delegatePub: String, issuedAt: Int64) { self.delegatePub = delegatePub; self.issuedAt = issuedAt }
    public var json: JSONValue { ["delegatePub": .string(delegatePub), "issuedAt": .int(issuedAt)] }
}

public enum WebDelegations {
    public static let tagWebDelegation = "flagship/web-delegation/v1"
    public static let tagWebDelegationRevoke = "flagship/web-delegation-revoke/v1"
    public static let scopes = ["voici-messages"]
    public static let voiciWebOrigin = "https://voi.ci"
    public static let voiciWebOriginGym = "https://gym.voi.ci"

    /// `^https://[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$`
    static func isOrigin(_ s: String) -> Bool {
        guard s.hasPrefix("https://") else { return false }
        let h = Array(s.utf8.dropFirst(8))
        guard (1...253).contains(h.count) else { return false }
        func an(_ c: UInt8) -> Bool { (0x61...0x7a).contains(c) || (0x30...0x39).contains(c) }
        return an(h[0]) && an(h[h.count - 1]) && h.allSatisfy { an($0) || $0 == 0x2e || $0 == 0x2d }
    }

    static func isAudience(_ s: String) -> Bool {
        let u = s.utf8
        return (1...64).contains(u.count) && u.allSatisfy { (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2d }
    }

    static func isP256Pub(_ s: String) -> Bool { CanonicalJson.isLowerHex(s, bytes: 65) && s.hasPrefix("04") }

    public static func canonicalWebDelegation(_ d: WebDelegation) throws -> [UInt8] {
        func bad(_ f: String) -> CanonicalJsonError { CanonicalJsonError("\(tagWebDelegation): bad \(f)") }
        guard scopes.contains(where: { CanonicalJson.same($0, d.scope) }) else { throw bad("scope") }
        guard isOrigin(d.origin) else { throw bad("origin") }
        guard isAudience(d.audience) else { throw bad("audience") }
        guard CanonicalJson.isLowerHex(d.principalPub, bytes: 32) else { throw bad("principalPub") }
        guard d.delegateAlg == "p256", isP256Pub(d.delegatePub) else { throw bad("delegate") }
        guard CanonicalJson.isTime(d.issuedAt), CanonicalJson.isTime(d.expiresAt), d.expiresAt > d.issuedAt else { throw bad("time") }
        guard CanonicalJson.isLowerHex(d.nonce, bytes: 16) else { throw bad("nonce") }
        return CanonicalJson.join([tagWebDelegation, d.scope, d.origin, d.audience, d.principalPub, d.delegateAlg, d.delegatePub,
                                   String(d.issuedAt), String(d.expiresAt), d.nonce])
    }

    /// Ed25519 signature (hex) by the principal's 32-byte seed.
    public static func signWebDelegation(_ d: WebDelegation, principalSeed: [UInt8]) throws -> String {
        try CanonicalJson.ed25519SignHex(try canonicalWebDelegation(d), seed: principalSeed)
    }

    static let delegationKeys: Set<String> = ["audience", "delegateAlg", "delegatePub", "expiresAt", "issuedAt", "nonce", "origin", "principalPub", "scope"]

    /// Strict shape (exact keys, string and integer types, then the canonical rules); nil when malformed.
    public static func parseWebDelegation(_ v: JSONValue?) -> WebDelegation? {
        guard let r = v?.object, Set(r.keys) == delegationKeys,
              let scope = r["scope"]?.string, let origin = r["origin"]?.string, let audience = r["audience"]?.string,
              let principalPub = r["principalPub"]?.string, let alg = r["delegateAlg"]?.string,
              let delegatePub = r["delegatePub"]?.string, let issuedAt = r["issuedAt"]?.safeInt,
              let expiresAt = r["expiresAt"]?.safeInt, let nonce = r["nonce"]?.string else { return nil }
        let d = WebDelegation(scope: scope, origin: origin, audience: audience, principalPub: principalPub, delegateAlg: alg,
                              delegatePub: delegatePub, issuedAt: issuedAt, expiresAt: expiresAt, nonce: nonce)
        return (try? canonicalWebDelegation(d)) != nil ? d : nil
    }

    public struct Want: Sendable {
        public var scope: String
        public var origin: String
        public var audience: String
        public var principalPub: String
        public var now: Int64
        /// The attestation's expiresAt: caps the delegation's.
        public var notAfter: Int64?
        public init(scope: String = "voici-messages", origin: String, audience: String, principalPub: String, now: Int64, notAfter: Int64? = nil) {
            self.scope = scope; self.origin = origin; self.audience = audience; self.principalPub = principalPub; self.now = now; self.notAfter = notAfter
        }
    }

    /// Signature by `principalPub`, then scope, origin, audience, principal, the cap, and `now` in [issuedAt, expiresAt).
    public static func checkWebDelegation(_ d: JSONValue?, signature: JSONValue?, want: Want) -> VoiciVerdict<WebDelegation, WebDelegation.Refusal> {
        guard let p = parseWebDelegation(d), let sig = signature?.string else { return .refused(.malformed) }
        guard let bytes = try? canonicalWebDelegation(p), CanonicalJson.ed25519VerifyHex(sig, bytes, p.principalPub) else { return .refused(.badSignature) }
        if !CanonicalJson.same(p.scope, want.scope) { return .refused(.wrongScope) }
        if !CanonicalJson.same(p.origin, want.origin) { return .refused(.wrongOrigin) }
        if !CanonicalJson.same(p.audience, want.audience) { return .refused(.wrongAudience) }
        if !CanonicalJson.same(p.principalPub, want.principalPub) { return .refused(.wrongPrincipal) }
        if let cap = want.notAfter, p.expiresAt > cap { return .refused(.tooLong) }
        if want.now < p.issuedAt { return .refused(.notYetValid) }
        if want.now >= p.expiresAt { return .refused(.expired) }
        return .ok(p)
    }

    public static func canonicalWebDelegationRevoke(_ r: WebDelegationRevoke) throws -> [UInt8] {
        guard isP256Pub(r.delegatePub) else { throw CanonicalJsonError("\(tagWebDelegationRevoke): bad delegatePub") }
        guard CanonicalJson.isTime(r.issuedAt) else { throw CanonicalJsonError("\(tagWebDelegationRevoke): bad issuedAt") }
        return CanonicalJson.join([tagWebDelegationRevoke, r.delegatePub, String(r.issuedAt)])
    }

    public static func signWebDelegationRevoke(_ r: WebDelegationRevoke, principalSeed: [UInt8]) throws -> String {
        try CanonicalJson.ed25519SignHex(try canonicalWebDelegationRevoke(r), seed: principalSeed)
    }

    public static func verifyWebDelegationRevoke(_ r: WebDelegationRevoke, signature: String, principalPub: String) -> Bool {
        guard let bytes = try? canonicalWebDelegationRevoke(r) else { return false }
        return CanonicalJson.ed25519VerifyHex(signature, bytes, principalPub)
    }

    public static func parseWebDelegationRevoke(_ v: JSONValue?) -> WebDelegationRevoke? {
        guard let r = v?.object, Set(r.keys) == ["delegatePub", "issuedAt"], let pub = r["delegatePub"]?.string, isP256Pub(pub),
              let at = r["issuedAt"]?.time else { return nil }
        return WebDelegationRevoke(delegatePub: pub, issuedAt: at)
    }
}
