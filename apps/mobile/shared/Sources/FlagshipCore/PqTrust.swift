import Foundation

/// Architecture v2: a hybrid key binding for every identity, and the one gate every critical
/// signature goes through. Swift twin of packages/protocol/src/pqTrust.ts (codes and check order
/// identical). DRAFT, pending Q01 external cryptographic review.
/// Spec: docs/architecture-v2/pq-suites.md §9-§10. Vectors: test-vectors/pq-binding/.
///
///   flagship/pq-key-binding/v1|<role>|<subjectId>|<ed25519PubHex>|<mldsa65PubHex>|<issuedAt>
///
/// is signed by both keys with the hybrid suite under `ed25519 || mldsa65`, a mutual proof of
/// possession. `verifyCriticalSignature` lets the scope's PolicyState, never the envelope, pick
/// what is required, so stripping the hybrid suite cannot downgrade a strict scope.
public enum PqTrust {
    public static let tagPqKeyBinding = "flagship/pq-key-binding/v1"
    public static let roles = ["account-irk", "admin-root", "device", "box-stk", "boot-key", "release-key"]
    /// How far ahead of the verifier's clock a binding may be dated.
    public static let maxSkewMs: Int64 = 5 * 60 * 1000
    static let mldsaPubHexLen = 1952 * 2
    static let maxSafeInteger: Int64 = (1 << 53) - 1
}

public enum PqBindingRole: String, CaseIterable, Codable, Sendable {
    case accountIrk = "account-irk"
    case adminRoot = "admin-root"
    case device
    case boxStk = "box-stk"
    case bootKey = "boot-key"
}

/// A refusal; `code` matches the TS/Rust ports and the vectors' `code`.
public struct PqTrustError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public init(_ code: String) { self.code = code }
    public var description: String { code }
}

private func trustFail(_ code: String) -> PqTrustError { PqTrustError(code) }

public struct PqKeyBindingStatement: Equatable, Sendable {
    public var role: String
    public var subjectId: String
    public var ed25519PubHex: String
    public var mldsaPubHex: String
    public var issuedAt: Int64

    public init(role: String, subjectId: String, ed25519PubHex: String, mldsaPubHex: String, issuedAt: Int64) {
        self.role = role; self.subjectId = subjectId; self.ed25519PubHex = ed25519PubHex
        self.mldsaPubHex = mldsaPubHex; self.issuedAt = issuedAt
    }
}

/// The wire shape `{ v: 1, role, subjectId, ed25519PubHex, mldsaPubHex, issuedAt, signature }`.
public struct PqKeyBindingWire: Codable, Equatable, Sendable {
    public var v: Int
    public var role: String
    public var subjectId: String
    public var ed25519PubHex: String
    public var mldsaPubHex: String
    public var issuedAt: Int64
    /// The hybrid signature (3373 bytes), lowercase hex.
    public var signature: String

    public init(statement s: PqKeyBindingStatement, signature: String) {
        v = 1; role = s.role; subjectId = s.subjectId; ed25519PubHex = s.ed25519PubHex
        mldsaPubHex = s.mldsaPubHex; issuedAt = s.issuedAt; self.signature = signature
    }

    public var statement: PqKeyBindingStatement {
        PqKeyBindingStatement(role: role, subjectId: subjectId, ed25519PubHex: ed25519PubHex, mldsaPubHex: mldsaPubHex, issuedAt: issuedAt)
    }

    /// A JSONSerialization object, for verifiers that take the raw wire.
    public var jsonObject: [String: Any] {
        ["v": v, "role": role, "subjectId": subjectId, "ed25519PubHex": ed25519PubHex,
         "mldsaPubHex": mldsaPubHex, "issuedAt": NSNumber(value: issuedAt), "signature": signature]
    }
}

/// A binding that verified. Only `PqTrust.verifyPqKeyBinding` makes one (its initializer needs a
/// file-private token), so the gate refuses look-alikes.
public final class VerifiedPqKeyBinding: @unchecked Sendable {
    fileprivate struct Token {}
    public let role: String
    public let subjectId: String
    public let ed25519PubHex: String
    public let mldsaPubHex: String
    public let issuedAt: Int64
    public let hybridPublicKey: [UInt8]
    /// `pqKeyId(0x0002, hybridPublicKey)`, hex.
    public let keyIdHex: String

    fileprivate init(_: Token, role: String, subjectId: String, ed25519PubHex: String, mldsaPubHex: String,
                     issuedAt: Int64, hybridPublicKey: [UInt8]) {
        self.role = role; self.subjectId = subjectId; self.ed25519PubHex = ed25519PubHex
        self.mldsaPubHex = mldsaPubHex; self.issuedAt = issuedAt; self.hybridPublicKey = hybridPublicKey
        self.keyIdHex = PqBin.hex(PqHybrid.pqKeyId(suite: PqHybrid.suiteHybridSigEd25519MlDsa65V1, publicKey: hybridPublicKey))
    }
}

public struct PqBindingExpectation {
    public var role: String
    public var subjectId: String
    /// The Ed25519 key the verifier already trusts (pinned, or registered).
    public var ed25519PubHex: String
    /// The ML-DSA key already pinned for this identity, if any: a different one is refused.
    public var mldsaPubHex: String?
    public var now: Int64
    /// Refuse a binding dated before this (the pin's own binding, or the key's registration).
    public var minIssuedAt: Int64?

    public init(role: String, subjectId: String, ed25519PubHex: String, mldsaPubHex: String? = nil, now: Int64, minIssuedAt: Int64? = nil) {
        self.role = role; self.subjectId = subjectId; self.ed25519PubHex = ed25519PubHex
        self.mldsaPubHex = mldsaPubHex; self.now = now; self.minIssuedAt = minIssuedAt
    }
}

extension PqTrust {
    static func isSubject(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard b.count >= 1, b.count <= 253, b.count == s.unicodeScalars.count else { return false }
        func lead(_ c: UInt8) -> Bool { (0x61...0x7a).contains(c) || (0x30...0x39).contains(c) }
        return lead(b[0]) && b.dropFirst().allSatisfy { lead($0) || $0 == 0x2e || $0 == 0x5f || $0 == 0x3a || $0 == 0x40 || $0 == 0x2d }
    }

    static func isHex32(_ s: String) -> Bool { s.utf8.count == 64 && PqBin.isLowerHex(s) }
    static func isMldsaHex(_ s: String) -> Bool { s.utf8.count == mldsaPubHexLen && PqBin.isLowerHex(s) }

    public static func isRole(_ r: String) -> Bool { roles.contains(r) }

    static func checkStatement(_ s: PqKeyBindingStatement) throws {
        if !isRole(s.role) { throw trustFail("binding-role") }
        if !isSubject(s.subjectId) { throw trustFail("binding-subject") }
        if !isHex32(s.ed25519PubHex) { throw trustFail("binding-malformed") }
        if !isMldsaHex(s.mldsaPubHex) { throw trustFail("binding-malformed") }
        if s.issuedAt < 0 || s.issuedAt > maxSafeInteger { throw trustFail("binding-malformed") }
    }

    /// The statement both keys sign.
    public static func canonicalPqKeyBinding(_ s: PqKeyBindingStatement) throws -> [UInt8] {
        try checkStatement(s)
        return Array([tagPqKeyBinding, s.role, s.subjectId, s.ed25519PubHex, s.mldsaPubHex, String(s.issuedAt)].joined(separator: "|").utf8)
    }

    /// `ed25519 || mldsa65`, the hybrid suite's public key for this binding.
    public static func pqBindingPublicKey(ed25519PubHex: String, mldsaPubHex: String) -> [UInt8] {
        PqBin.unhex(ed25519PubHex + mldsaPubHex) ?? []
    }

    /// Signs with a hybrid signer over the statement (purpose = the binding tag). The signer is
    /// whatever holds the two halves: a software seed pair, or a Secure Enclave ML-DSA key.
    public static func signPqKeyBinding(_ s: PqKeyBindingStatement, signer: (_ purpose: String, _ payload: [UInt8]) throws -> [UInt8]) throws -> PqKeyBindingWire {
        let sig = try signer(tagPqKeyBinding, try canonicalPqKeyBinding(s))
        return PqKeyBindingWire(statement: s, signature: PqBin.hex(sig))
    }

    private static func int64(_ v: Any?) -> Int64? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d == d.rounded(), abs(d) <= Double(maxSafeInteger) else { return nil }
        return Int64(d)
    }

    /// Parses the wire shape strictly (a JSONSerialization object); codes as `verifyPqKeyBinding`.
    public static func pqKeyBindingFromWire(_ w: Any?) throws -> PqKeyBindingWire {
        guard let o = w as? [String: Any] else { throw trustFail("binding-malformed") }
        let keys = o.keys.sorted().joined(separator: ",")
        guard keys == "ed25519PubHex,issuedAt,mldsaPubHex,role,signature,subjectId,v", int64(o["v"]) == 1 else {
            throw trustFail("binding-malformed")
        }
        guard let sig = o["signature"] as? String, sig.utf8.count <= 2 * 65536, PqBin.isLowerHex(sig) else { throw trustFail("binding-malformed") }
        guard let ed = o["ed25519PubHex"] as? String, isHex32(ed) else { throw trustFail("binding-malformed") }
        guard let ml = o["mldsaPubHex"] as? String, isMldsaHex(ml) else { throw trustFail("binding-malformed") }
        guard let issuedAt = int64(o["issuedAt"]), issuedAt >= 0 else { throw trustFail("binding-malformed") }
        guard let role = o["role"] as? String, isRole(role) else { throw trustFail("binding-role") }
        guard let subject = o["subjectId"] as? String, isSubject(subject) else { throw trustFail("binding-subject") }
        return PqKeyBindingWire(statement: PqKeyBindingStatement(role: role, subjectId: subject, ed25519PubHex: ed, mldsaPubHex: ml, issuedAt: issuedAt), signature: sig)
    }

    /// Verifies a binding. Order (every port): wire shape; role, subject and Ed25519 key against
    /// what the verifier expects; a changed ML-DSA pin; dated in the future; older than allowed;
    /// the hybrid public key; the hybrid signature over the statement.
    public static func verifyPqKeyBinding(_ wire: Any?, _ expect: PqBindingExpectation) throws -> VerifiedPqKeyBinding {
        let w = try pqKeyBindingFromWire(wire)
        if w.role != expect.role { throw trustFail("binding-role") }
        if w.subjectId != expect.subjectId { throw trustFail("binding-subject") }
        if w.ed25519PubHex != expect.ed25519PubHex.lowercased() { throw trustFail("binding-key-mismatch") }
        if let pinned = expect.mldsaPubHex, !pinned.isEmpty, w.mldsaPubHex != pinned.lowercased() { throw trustFail("binding-pq-key-changed") }
        if w.issuedAt > expect.now + maxSkewMs { throw trustFail("binding-future") }
        if let min = expect.minIssuedAt, w.issuedAt < min { throw trustFail("binding-stale") }
        let pk = pqBindingPublicKey(ed25519PubHex: w.ed25519PubHex, mldsaPubHex: w.mldsaPubHex)
        let sig = PqBin.unhex(w.signature) ?? []
        do { try PqHybrid.parseHybridSigPublicKey(pk) } catch { throw trustFail("bad-public-key") }
        do {
            try PqHybrid.hybridVerify(publicKey: pk, purpose: tagPqKeyBinding, payload: try canonicalPqKeyBinding(w.statement), signature: sig)
        } catch let e as PqHybridError where e.code == "bad-public-key" {
            throw trustFail("bad-public-key")
        } catch {
            throw trustFail("bad-signature")
        }
        return VerifiedPqKeyBinding(.init(), role: w.role, subjectId: w.subjectId, ed25519PubHex: w.ed25519PubHex,
                                    mldsaPubHex: w.mldsaPubHex, issuedAt: w.issuedAt, hybridPublicKey: pk)
    }

    /// The same, from a typed wire (e.g. one this device just made).
    public static func verifyPqKeyBinding(_ wire: PqKeyBindingWire, _ expect: PqBindingExpectation) throws -> VerifiedPqKeyBinding {
        try verifyPqKeyBinding(wire.jsonObject as Any?, expect)
    }
}

// MARK: - The gate (§10)

/// A critical message's signature as it travels: the suite it claims and the bytes.
public struct SignatureEnvelope: Codable, Equatable, Sendable {
    /// `ed25519/v1` (64-byte signature) or `hybrid-ed25519-mldsa65/v1` (3373 bytes); kept as a
    /// string so an unknown suite is refused as `unknown-suite`, not lost in decoding.
    public var suite: String
    /// Lowercase hex.
    public var signature: String
    public init(suite: String, signature: String) { self.suite = suite; self.signature = signature }
}

public struct CriticalSignatureVerdict: Equatable, Sendable {
    public let suite: SignatureSuite
    /// True when the strict profile was in force for this check.
    public let strict: Bool
}

extension PqTrust {
    /// Everything before the first `|`, or "" when there is none.
    public static func messagePurpose(_ msg: [UInt8]) -> String {
        guard let bar = msg.firstIndex(of: 0x7c), bar > 0 else { return "" }
        return String(validating: msg[0..<bar], as: UTF8.self) ?? ""
    }

    /// The one check for a critical signature. Order (every port): purpose grammar and match; the
    /// envelope's suite and signature encoding; the binding is for this signer; the scope's
    /// policy (strict needs the hybrid suite and a binding); the signature itself.
    public static func verifyCriticalSignature(message: [UInt8], expectedPurpose: String, envelope: SignatureEnvelope,
                                               signerEd25519PubHex: String, binding: VerifiedPqKeyBinding?,
                                               policy: PolicyState) throws -> CriticalSignatureVerdict {
        if !PqHybrid.validatePurposeTag(expectedPurpose) { throw trustFail("bad-purpose") }
        if messagePurpose(message) != expectedPurpose { throw trustFail("purpose-mismatch") }
        guard let suite = SignatureSuite(rawValue: envelope.suite) else { throw trustFail("unknown-suite") }
        guard let sig = PqBin.unhex(envelope.signature) else { throw trustFail("bad-signature") }
        let signer = signerEd25519PubHex.lowercased()
        if !isHex32(signer) { throw trustFail("bad-public-key") }
        if let binding, binding.ed25519PubHex != signer { throw trustFail("binding-key-mismatch") }
        let strict = AssurancePolicy.strictInForce(policy)
        if strict && suite != .hybrid { throw trustFail("strict-requires-hybrid") }
        if strict && binding == nil { throw trustFail("strict-requires-binding") }
        switch suite {
        case .hybrid:
            guard let binding else { throw trustFail("no-binding") }
            if sig.count != PqHybrid.sigLen { throw trustFail("bad-signature") }
            do {
                try PqHybrid.hybridVerify(publicKey: binding.hybridPublicKey, purpose: expectedPurpose, payload: message, signature: sig)
            } catch {
                throw trustFail("bad-signature")
            }
        case .ed25519:
            if sig.count != 64 { throw trustFail("bad-signature") }
            if !PqHybrid.ed25519VerifyStrict(signature: sig, message: message, publicKey: PqBin.unhex(signer) ?? []) {
                throw trustFail("bad-signature")
            }
        }
        return CriticalSignatureVerdict(suite: suite, strict: strict)
    }
}
