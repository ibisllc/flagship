import Foundation

/// Messages key attestations (docs/voici-and-messages.md §6.3, §9.3): `.com`'s CA vouches that a Flagship account in
/// good standing holds a per-page pseudonym key P, naming no account. Swift twin of the request / answer half of
/// packages/protocol/src/messagesAttestation.ts, pinned by packages/protocol/test-vectors/messages/vectors.json
/// (`attestation`). The app never seals or opens the abuse tag: here it is opaque bytes whose SHA-256 the CA signs.
///
///   request flagship/messages-key-attestation-request/v1|<username>|<Ppub>|<renewOfHash or "">|<deviceCheckRef>|<issuedAt>
///           (Ed25519 by an account device key)
///   answer  flagship/messages-key-attestation/v1|<Ppub>|<abuseEpoch>|<H(abuseTag)>|<issuedAt>|<expiresAt>
///           (Ed25519 by the CA); renewOfHash = SHA-256 hex of canonicalJson(previous attestation).
///
/// Public API: MessagesKeyAttestationRequest, MessagesKeyAttestation (struct, `json`), MessagesKeyAttestation.Refusal,
/// MessagesAttestations namespace: tagMessagesKeyAttestation, tagMessagesKeyAttestationRequest, ttlMs,
/// renewGraceMs, requestSkewMs, deviceCheckRefs, canonicalMessagesKeyAttestationRequest,
/// signMessagesKeyAttestationRequest, verifyMessagesKeyAttestationRequest, canonicalMessagesKeyAttestation,
/// parseMessagesKeyAttestation, messagesAttestationHash, checkMessagesKeyAttestation.
public struct MessagesKeyAttestationRequest: Equatable, Sendable {
    public var username: String
    public var pseudonymPub: String
    /// "" for a first attestation.
    public var renewOfHash: String
    /// "ios", "android" or "none".
    public var deviceCheckRef: String
    public var issuedAt: Int64
    public init(username: String, pseudonymPub: String, renewOfHash: String, deviceCheckRef: String, issuedAt: Int64) {
        self.username = username; self.pseudonymPub = pseudonymPub; self.renewOfHash = renewOfHash
        self.deviceCheckRef = deviceCheckRef; self.issuedAt = issuedAt
    }
}

public struct MessagesKeyAttestation: Equatable, Sendable {
    public enum Refusal: String, Sendable {
        case malformed, unknownCa = "unknown-ca", badSignature = "bad-signature", badAbuseTag = "bad-abuse-tag"
        case wrongKey = "wrong-key", notYetValid = "not-yet-valid", expired
    }

    public var pseudonymPub: String
    public var abuseEpoch: Int64
    public var abuseTagHash: String
    /// Standard base64 of the sealed abuse tag (opaque to the app).
    public var abuseTag: String
    public var issuedAt: Int64
    public var expiresAt: Int64
    public var signedBy: String
    public var signature: String

    public init(pseudonymPub: String, abuseEpoch: Int64, abuseTagHash: String, abuseTag: String, issuedAt: Int64, expiresAt: Int64,
                signedBy: String, signature: String) {
        self.pseudonymPub = pseudonymPub; self.abuseEpoch = abuseEpoch; self.abuseTagHash = abuseTagHash; self.abuseTag = abuseTag
        self.issuedAt = issuedAt; self.expiresAt = expiresAt; self.signedBy = signedBy; self.signature = signature
    }

    public var json: JSONValue {
        ["kind": "MessagesKeyAttestation", "version": 1, "pseudonymPub": .string(pseudonymPub), "abuseEpoch": .int(abuseEpoch),
         "abuseTagHash": .string(abuseTagHash), "abuseTag": .string(abuseTag), "issuedAt": .int(issuedAt),
         "expiresAt": .int(expiresAt), "signedBy": .string(signedBy), "signature": .string(signature)]
    }
}

public enum MessagesAttestations {
    public static let tagMessagesKeyAttestation = "flagship/messages-key-attestation/v1"
    public static let tagMessagesKeyAttestationRequest = "flagship/messages-key-attestation-request/v1"
    public static let ttlMs: Int64 = 30 * 86_400_000
    public static let renewGraceMs: Int64 = 7 * 86_400_000
    public static let requestSkewMs: Int64 = 10 * 60_000
    public static let deviceCheckRefs = ["ios", "android", "none"]
    static let abuseTagMaxBytes = 4096

    /// `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`
    static func isUsername(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard (1...64).contains(u.count) else { return false }
        func an(_ c: UInt8) -> Bool { (0x61...0x7a).contains(c) || (0x30...0x39).contains(c) }
        return an(u[0]) && an(u[u.count - 1]) && u.allSatisfy { an($0) || $0 == 0x2d }
    }

    public static func canonicalMessagesKeyAttestationRequest(_ r: MessagesKeyAttestationRequest) throws -> [UInt8] {
        func bad(_ f: String) -> CanonicalJsonError { CanonicalJsonError("\(tagMessagesKeyAttestationRequest): bad \(f)") }
        guard isUsername(r.username) else { throw bad("username") }
        guard CanonicalJson.isLowerHex(r.pseudonymPub, bytes: 32) else { throw bad("pseudonymPub") }
        guard r.renewOfHash.isEmpty || CanonicalJson.isLowerHex(r.renewOfHash, bytes: 32) else { throw bad("renewOfHash") }
        guard deviceCheckRefs.contains(where: { CanonicalJson.same($0, r.deviceCheckRef) }) else { throw bad("deviceCheckRef") }
        guard CanonicalJson.isTime(r.issuedAt) else { throw bad("issuedAt") }
        return CanonicalJson.join([tagMessagesKeyAttestationRequest, r.username, r.pseudonymPub, r.renewOfHash, r.deviceCheckRef, String(r.issuedAt)])
    }

    public static func signMessagesKeyAttestationRequest(_ r: MessagesKeyAttestationRequest, deviceSeed: [UInt8]) throws -> String {
        try CanonicalJson.ed25519SignHex(try canonicalMessagesKeyAttestationRequest(r), seed: deviceSeed)
    }

    public static func verifyMessagesKeyAttestationRequest(_ r: MessagesKeyAttestationRequest, signature: String, devicePub: String) -> Bool {
        guard let bytes = try? canonicalMessagesKeyAttestationRequest(r) else { return false }
        return CanonicalJson.ed25519VerifyHex(signature, bytes, devicePub)
    }

    public static func canonicalMessagesKeyAttestation(pseudonymPub: String, abuseEpoch: Int64, abuseTagHash: String, issuedAt: Int64, expiresAt: Int64) throws -> [UInt8] {
        func bad(_ f: String) -> CanonicalJsonError { CanonicalJsonError("\(tagMessagesKeyAttestation): bad \(f)") }
        guard CanonicalJson.isLowerHex(pseudonymPub, bytes: 32) else { throw bad("pseudonymPub") }
        guard CanonicalJson.isTime(abuseEpoch), abuseEpoch >= 1 else { throw bad("abuseEpoch") }
        guard CanonicalJson.isLowerHex(abuseTagHash, bytes: 32) else { throw bad("abuseTagHash") }
        guard CanonicalJson.isTime(issuedAt), CanonicalJson.isTime(expiresAt), expiresAt > issuedAt else { throw bad("time") }
        return CanonicalJson.join([tagMessagesKeyAttestation, pseudonymPub, String(abuseEpoch), abuseTagHash, String(issuedAt), String(expiresAt)])
    }

    public static func canonicalMessagesKeyAttestation(_ a: MessagesKeyAttestation) throws -> [UInt8] {
        try canonicalMessagesKeyAttestation(pseudonymPub: a.pseudonymPub, abuseEpoch: a.abuseEpoch, abuseTagHash: a.abuseTagHash,
                                            issuedAt: a.issuedAt, expiresAt: a.expiresAt)
    }

    static let attestationKeys: Set<String> = ["abuseEpoch", "abuseTag", "abuseTagHash", "expiresAt", "issuedAt", "kind", "pseudonymPub", "signature", "signedBy", "version"]

    /// Strict shape (exact keys, hex lengths, canonical base64 of at most 4 KiB); no signature check.
    public static func parseMessagesKeyAttestation(_ v: JSONValue?) -> MessagesKeyAttestation? {
        guard let r = v?.object, Set(r.keys) == attestationKeys, r["kind"]?.string == "MessagesKeyAttestation",
              r["version"]?.isOne == true, let tag = CanonicalJson.b64Decode(r["abuseTag"]), tag.count <= abuseTagMaxBytes,
              CanonicalJson.isLowerHex(r["signedBy"], bytes: 32), CanonicalJson.isLowerHex(r["signature"], bytes: 64),
              let p = r["pseudonymPub"]?.string, let epoch = r["abuseEpoch"]?.safeInt, let h = r["abuseTagHash"]?.string,
              let issuedAt = r["issuedAt"]?.safeInt, let expiresAt = r["expiresAt"]?.safeInt else { return nil }
        let a = MessagesKeyAttestation(pseudonymPub: p, abuseEpoch: epoch, abuseTagHash: h, abuseTag: r["abuseTag"]!.string!,
                                       issuedAt: issuedAt, expiresAt: expiresAt, signedBy: r["signedBy"]!.string!, signature: r["signature"]!.string!)
        return (try? canonicalMessagesKeyAttestation(a)) != nil ? a : nil
    }

    /// What a renewal names: SHA-256 hex of the canonical JSON of the previous attestation.
    public static func messagesAttestationHash(_ a: MessagesKeyAttestation) throws -> String {
        CanonicalJson.sha256Hex(try CanonicalJson.canonicalJsonBytes(a.json))
    }

    /// Shape, signedBy among `caKeys`, the CA signature, H(abuseTag) = abuseTagHash, the key when given, and `now`
    /// inside [issuedAt, expiresAt).
    public static func checkMessagesKeyAttestation(_ v: JSONValue?, caKeys: [String], now: Int64, pseudonymPub: String? = nil)
        -> VoiciVerdict<MessagesKeyAttestation, MessagesKeyAttestation.Refusal> {
        guard let a = parseMessagesKeyAttestation(v) else { return .refused(.malformed) }
        guard caKeys.contains(where: { CanonicalJson.same($0, a.signedBy) }) else { return .refused(.unknownCa) }
        guard let bytes = try? canonicalMessagesKeyAttestation(a), CanonicalJson.ed25519VerifyHex(a.signature, bytes, a.signedBy) else { return .refused(.badSignature) }
        guard let tag = CanonicalJson.b64Decode(a.abuseTag), CanonicalJson.sha256Hex(tag) == a.abuseTagHash else { return .refused(.badAbuseTag) }
        if let want = pseudonymPub, !CanonicalJson.same(want, a.pseudonymPub) { return .refused(.wrongKey) }
        if now < a.issuedAt { return .refused(.notYetValid) }
        if now >= a.expiresAt { return .refused(.expired) }
        return .ok(a)
    }
}
