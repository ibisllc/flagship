import Foundation
import CryptoKit

/// Maintainers protocol — native Swift trust port (#10).
///
/// This is a byte-for-byte reimplementation of the TypeScript reference
/// in `maintainers/packages/protocol/src/{canonical,verifier,endorsement,
/// caEndorsement}.ts`. It MUST produce the identical verdict for every
/// vector in `maintainers/conformance/`. The whole model in one sentence:
/// "pin a mandate, verify FORWARD; the mandate carries its own succession
/// rule; there is no privileged self-renewal."
///
/// Crypto is Apple CryptoKit only (no SwiftPM deps): Ed25519 over the
/// canonical UTF-8 bytes, SHA-256 (lower-hex) for the pin. PIV-Ed25519 ==
/// standard Ed25519, so verification is plain `Curve25519.Signing`.
///
/// Every public entry point is TOTAL: it never throws on adversarial
/// input. A field that fails canonicalization, an unparseable timestamp,
/// a malformed number — every such case is a rejection / rootError, never
/// a propagated error. Fail-closed is a return value, not an exception.
public enum MaintainersTrust {

    /// The pinned mandate hash baked into this surface (#30 generalised,
    /// the iOS half of #10). This is the `mandatePinHash` (SHA-256 lower
    /// hex of a mandate's canonical bytes) of the Flagship maintainers
    /// genesis mandate. It mirrors the TypeScript
    /// `MAINTAINER_PINNED_MANDATE_HASH` exactly.
    ///
    /// Invariant (preserved from the TS side): an EMPTY pin ⇒ fail-closed
    /// (reject all, reason `no-pin`); a non-empty pin ⇒ verify forward
    /// from it; NEVER fall back to an env / previously-seen pin. This
    /// constant is the default pin the iOS verify-forward consumer uses.
    public static let pinnedMandateHash =
        "5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae"
}

// MARK: - Envelope models

public struct MaintainersSignature: Sendable, Equatable {
    public let pubkey: String
    public let sig: String
    public init(pubkey: String, sig: String) {
        self.pubkey = pubkey
        self.sig = sig
    }
}

public struct MaintainersApprovalRule: Sendable, Equatable {
    public let kind: String
    public let threshold: Int
}

public struct MaintainersProject: Sendable, Equatable {
    public let name: String?
    public let contact: String?
    public let homepage: String?
    public let tracks: [String]?
}

public struct Mandate: Sendable, Equatable {
    public let kind: String
    public let version: Int
    public let mandateId: String
    public let track: String
    public let holder: String
    public let issuedAt: String
    public let expiresAt: String
    public let successors: [String]
    public let approvalRule: MaintainersApprovalRule
    public let minSuccessors: Int
    public let maxDurationSeconds: Int
    public let defaultDurationSeconds: Int
    public let project: MaintainersProject?
    public let signedBy: String
    public let signatures: [MaintainersSignature]
}

public struct ReleaseEndorsement: Sendable, Equatable {
    public let kind: String
    public let version: Int
    public let releaseId: String
    public let semverTag: String
    public let commitHash: String
    public let previousReleaseId: String?
    public let previousCommitHash: String?
    public let intermediateCommits: [String]
    public let intermediateMerkleRoot: String
    public let endorsedNotes: String?
    public let issuedAt: String
    public let signedBy: String
    public let signatures: [MaintainersSignature]
}

public struct CaEndorsement: Sendable, Equatable {
    public let kind: String
    public let version: Int
    public let endorsementId: String
    public let track: String
    public let caPubkey: String
    public let scope: String
    public let notBefore: String
    public let notAfter: String
    public let issuedAt: String
    public let signedBy: String
    public let signatures: [MaintainersSignature]
}

// MARK: - Canonical-bytes derivation
//
// Convention: `maintainers/<kind>/v1|<f1>|<f2>|...`, UTF-8 encoded.
// Every field is validated to not contain `|` (0x7C), any C0 control
// byte (0x00-0x1F) or DEL (0x7F). Mirrors canonical.ts exactly.

enum CanonicalBytesError: Error { case invalid }

enum MaintainersCanonical {

    static let sep = "|"
    static let tagPrefix = "maintainers"
    static let version = "v1"

    /// Reject `|`, all C0 control chars, and DEL — mirrors
    /// canonical.ts `validateField` (iterates UTF-16 code units, which
    /// for these code points is equivalent to TS `charCodeAt`).
    static func validateField(_ value: String) throws {
        for u in value.unicodeScalars {
            let c = u.value
            if c == 0x7c { throw CanonicalBytesError.invalid }
            if c <= 0x1f || c == 0x7f { throw CanonicalBytesError.invalid }
        }
    }

    /// Reject `,` in addition to `|`/control — for fields embedded in a
    /// `,`-joined slot. Mirrors `validateNoComma`.
    static func validateNoComma(_ value: String) throws {
        try validateField(value)
        if value.contains(",") { throw CanonicalBytesError.invalid }
    }

    /// Exactly `length` lower-case hex digits. Mirrors `validateHex`.
    static func validateHex(_ value: String, _ length: Int) throws {
        if value.count != length { throw CanonicalBytesError.invalid }
        for u in value.unicodeScalars {
            let c = u.value
            let ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66)
            if !ok { throw CanonicalBytesError.invalid }
        }
    }

    static func validateHexOrEmpty(_ value: String?, _ length: Int) throws {
        guard let value, !value.isEmpty else { return }
        try validateHex(value, length)
    }

    /// Deterministic encoding of a non-negative safe integer. The TS uses
    /// `Number.MAX_SAFE_INTEGER` (2^53-1); Swift `Int` is 64-bit on iOS
    /// + macOS but 32-bit on watchOS (arm64_32), so type the bound as
    /// Int64 explicitly to avoid an integer-literal overflow when the
    /// SPM target gets pulled into the watchOS build pass. On watchOS
    /// every Int input is automatically ≤ Int.max (2^31-1) < maxSafe,
    /// so the upper-bound check becomes a no-op there but the input
    /// type still rejects anything that wouldn't round-trip through
    /// JS Numbers.
    static func canonicalUint(_ n: Int) throws -> String {
        let maxSafe: Int64 = 9_007_199_254_740_991
        if n < 0 || Int64(n) > maxSafe { throw CanonicalBytesError.invalid }
        return String(n)
    }

    static func joinTagged(_ kind: String, _ parts: [String]) -> Data {
        let tag = "\(tagPrefix)/\(kind)/\(version)"
        let all = ([tag] + parts).joined(separator: sep)
        return Data(all.utf8)
    }

    /// Mandate canonical bytes. Tag `maintainers/mandate/v1`, 15 slots:
    ///   mandateId | track | holder | issuedAt | expiresAt
    ///   | successors(,) | threshold | minSuccessors
    ///   | maxDurationSeconds | defaultDurationSeconds
    ///   | projectName | projectContact | projectHomepage
    ///   | projectTracks(,) | signedBy
    static func canonicalMandate(_ m: Mandate) throws -> Data {
        if m.kind != "Mandate" || m.version != 1 {
            throw CanonicalBytesError.invalid
        }
        try validateField(m.mandateId)
        try validateField(m.track)
        try validateHex(m.holder, 64)
        try validateField(m.issuedAt)
        try validateField(m.expiresAt)
        for s in m.successors { try validateHex(s, 64) }
        if m.approvalRule.kind != "threshold" {
            throw CanonicalBytesError.invalid
        }
        let threshold = try canonicalUint(m.approvalRule.threshold)
        let minSucc = try canonicalUint(m.minSuccessors)
        let maxDur = try canonicalUint(m.maxDurationSeconds)
        let defDur = try canonicalUint(m.defaultDurationSeconds)
        let p = m.project
        let projName = p?.name ?? ""
        let projContact = p?.contact ?? ""
        let projHome = p?.homepage ?? ""
        let projTracks = p?.tracks ?? []
        try validateField(projName)
        try validateField(projContact)
        try validateField(projHome)
        for t in projTracks { try validateNoComma(t) }
        try validateHex(m.signedBy, 64)
        return joinTagged("mandate", [
            m.mandateId,
            m.track,
            m.holder,
            m.issuedAt,
            m.expiresAt,
            m.successors.joined(separator: ","),
            threshold,
            minSucc,
            maxDur,
            defDur,
            projName,
            projContact,
            projHome,
            projTracks.joined(separator: ","),
            m.signedBy,
        ])
    }

    /// ReleaseEndorsement canonical bytes (tag `maintainers/release/v1`).
    static func canonicalReleaseEndorsement(_ e: ReleaseEndorsement) throws -> Data {
        try validateField(e.releaseId)
        try validateField(e.semverTag)
        try validateHex(e.commitHash, 40)
        try validateField(e.previousReleaseId ?? "")
        try validateHexOrEmpty(e.previousCommitHash, 40)
        try validateHex(e.intermediateMerkleRoot, 64)
        try validateField(e.endorsedNotes ?? "")
        try validateField(e.issuedAt)
        try validateHex(e.signedBy, 64)
        return joinTagged("release", [
            e.releaseId,
            e.semverTag,
            e.commitHash,
            e.previousReleaseId ?? "",
            e.previousCommitHash ?? "",
            e.intermediateMerkleRoot,
            e.endorsedNotes ?? "",
            e.issuedAt,
            e.signedBy,
        ])
    }

    /// CaEndorsement canonical bytes (tag `maintainers/ca-endorsement/v1`).
    static func canonicalCaEndorsement(_ e: CaEndorsement) throws -> Data {
        try validateField(e.endorsementId)
        try validateField(e.track)
        try validateHex(e.caPubkey, 64)
        try validateField(e.scope)
        try validateField(e.notBefore)
        try validateField(e.notAfter)
        try validateField(e.issuedAt)
        try validateHex(e.signedBy, 64)
        return joinTagged("ca-endorsement", [
            e.endorsementId,
            e.track,
            e.caPubkey,
            e.scope,
            e.notBefore,
            e.notAfter,
            e.issuedAt,
            e.signedBy,
        ])
    }

    /// SHA-256 (lower-hex) of a mandate's canonical bytes — the pin.
    static func mandatePinHash(_ m: Mandate) throws -> String {
        let bytes = try canonicalMandate(m)
        let digest = SHA256.hash(data: bytes)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Canonical Merkle root of intermediate commits: SHA-256 over the
    /// concatenated 20-byte raw representations. Mirrors
    /// crypto.ts `intermediateMerkleRoot` (throws on a bad commit hash).
    static func intermediateMerkleRoot(_ commitHashes: [String]) throws -> String {
        var buf = Data(capacity: commitHashes.count * 20)
        for h in commitHashes {
            if h.count != 40 { throw CanonicalBytesError.invalid }
            guard let bytes = MaintainersHex.toBytes(h), bytes.count == 20 else {
                throw CanonicalBytesError.invalid
            }
            buf.append(bytes)
        }
        let digest = SHA256.hash(data: buf)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Hex + Ed25519 (CryptoKit)

enum MaintainersHex {
    /// Lower/upper hex string → bytes, or nil on any malformed input
    /// (odd length, non-hex). Mirrors crypto.ts `hexToBytes` failure
    /// behaviour folded into nil so the verifier stays total.
    static func toBytes(_ hex: String) -> Data? {
        let chars = Array(hex.utf8)
        if chars.count % 2 != 0 { return nil }
        var out = Data(capacity: chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else {
                return nil
            }
            out.append((hi << 4) | lo)
            i += 2
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x61...0x66: return c - 0x61 + 10
        case 0x41...0x46: return c - 0x41 + 10
        default: return nil
        }
    }
}

enum MaintainersEd25519 {
    /// Verify an Ed25519 signature (hex) over `message` under `pubKeyHex`.
    /// Total: any malformed hex / bad key length / bad sig ⇒ false (never
    /// throws). Mirrors crypto.ts `verify` (try/catch ⇒ false).
    static func verify(sigHex: String, message: Data, pubKeyHex: String) -> Bool {
        guard let sig = MaintainersHex.toBytes(sigHex),
              let pub = MaintainersHex.toBytes(pubKeyHex) else {
            return false
        }
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pub) else {
            return false
        }
        return key.isValidSignature(sig, for: message)
    }
}

// MARK: - Timestamps
//
// The TS verifier uses `Date.parse(iso)` and arithmetic on the resulting
// epoch ms. The conformance vectors only ever use `...Z` ISO-8601
// instants. We parse to epoch milliseconds; an unparseable string ⇒ nil
// (mirrors `Date.parse` returning NaN ⇒ `isFinite` false ⇒ reject path).

enum MaintainersTime {
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let formatterFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func epochMs(_ iso: String) -> Double? {
        if let d = formatter.date(from: iso) {
            return d.timeIntervalSince1970 * 1000.0
        }
        if let d = formatterFrac.date(from: iso) {
            return d.timeIntervalSince1970 * 1000.0
        }
        return nil
    }
}

// MARK: - Verify-forward-from-pin (verifier.ts)

public enum V2FailReason: String, Sendable {
    case envelopeShapeInvalid = "envelope-shape-invalid"
    case duplicateMandateId = "duplicate-mandate-id"
    case wrongTrack = "wrong-track"
    case expiresBeforeIssuance = "expires-before-issuance"
    case issuedBeforePredecessor = "issued-before-predecessor"
    case signatureInvalid = "signature-invalid"
    case signedByNotInSignatures = "signed-by-not-in-signatures"
    case signerNotInSuccessorSet = "signer-not-in-successor-set"
    case approvalThresholdUnmet = "approval-threshold-unmet"
    case underMinSuccessors = "under-min-successors"
    case overMaxDuration = "over-max-duration"
}

public enum V2RootFailReason: String, Sendable {
    case noPin = "no-pin"
    case pinNotInLog = "pin-not-in-log"
    case rootShapeInvalid = "root-shape-invalid"
    case rootExpiresBeforeIssuance = "root-expires-before-issuance"
    case rootSignatureInvalid = "root-signature-invalid"
    case rootNotSelfSigned = "root-not-self-signed"
}

public struct V2Rejection: Sendable {
    public let mandate: Mandate
    public let reason: V2FailReason
}

public struct VerifiedChain: Sendable {
    public let pin: String
    public let root: Mandate?
    public let rootError: V2RootFailReason?
    public let validMandates: [Mandate]
    public let rejections: [V2Rejection]
}

public enum MaintainersVerifier {

    private static func canonicalOrNil(_ m: Mandate) -> Data? {
        try? MaintainersCanonical.canonicalMandate(m)
    }

    private static func pinHashOrNil(_ m: Mandate) -> String? {
        try? MaintainersCanonical.mandatePinHash(m)
    }

    private static func windowMs(_ issuedAt: String, _ expiresAt: String) -> Double? {
        guard let i = MaintainersTime.epochMs(issuedAt),
              let e = MaintainersTime.epochMs(expiresAt) else { return nil }
        return e - i
    }

    /// Every signature verifies over the mandate's canonical bytes?
    /// Mirrors `allSignaturesValid`: empty sig list ⇒ false; any bad
    /// sig ⇒ false; canonicalization failure ⇒ false.
    private static func allSignaturesValid(_ m: Mandate) -> Bool {
        guard let bytes = canonicalOrNil(m) else { return false }
        if m.signatures.isEmpty { return false }
        for s in m.signatures {
            if !MaintainersEd25519.verify(sigHex: s.sig, message: bytes, pubKeyHex: s.pubkey) {
                return false
            }
        }
        return true
    }

    /// Verify a single forward step K → K+1 against the predecessor's
    /// embedded policy (the L3 ONE rule). Mirrors `verifyForwardStep`.
    private static func verifyForwardStep(_ pred: Mandate, _ m: Mandate) -> V2FailReason? {
        // isMandateShape is enforced by typed decoding upstream; the one
        // dynamic shape failure the TS catches here (a non-hex holder
        // causing canonicalization to throw) surfaces as a signature
        // failure below, exactly like the reference.
        if m.track != pred.track { return .wrongTrack }
        guard let w = windowMs(m.issuedAt, m.expiresAt) else {
            return .envelopeShapeInvalid
        }
        if w <= 0 { return .expiresBeforeIssuance }
        guard let mi = MaintainersTime.epochMs(m.issuedAt),
              let pi = MaintainersTime.epochMs(pred.issuedAt) else {
            return .envelopeShapeInvalid
        }
        if mi < pi { return .issuedBeforePredecessor }
        if !allSignaturesValid(m) { return .signatureInvalid }

        let signerPubkeys = m.signatures.map { $0.pubkey }
        if !signerPubkeys.contains(m.signedBy) { return .signedByNotInSignatures }

        let successorSet = Set(pred.successors)
        for pk in signerPubkeys where !successorSet.contains(pk) {
            return .signerNotInSuccessorSet
        }
        var distinctAuthorised = Set<String>()
        for pk in signerPubkeys where successorSet.contains(pk) {
            distinctAuthorised.insert(pk)
        }
        if pred.approvalRule.kind != "threshold"
            || pred.approvalRule.threshold < 1
            || distinctAuthorised.count < pred.approvalRule.threshold {
            return .approvalThresholdUnmet
        }
        if m.successors.count < pred.minSuccessors { return .underMinSuccessors }
        if pred.maxDurationSeconds < 0
            || w > Double(pred.maxDurationSeconds) * 1000.0 {
            return .overMaxDuration
        }
        return nil
    }

    /// Verify a track's mandate log FORWARD from a baked pin. Mirrors
    /// `verifyMandateChainFromPin` accept/reject + reason strings.
    public static func verifyMandateChainFromPin(
        pinnedHash: String,
        mandates: [Mandate]
    ) -> VerifiedChain {
        if pinnedHash.isEmpty {
            return VerifiedChain(pin: pinnedHash, root: nil, rootError: .noPin,
                                  validMandates: [], rejections: [])
        }

        var rootIdx = -1
        for (i, m) in mandates.enumerated() {
            if pinHashOrNil(m) == pinnedHash {
                rootIdx = i
                break
            }
        }
        if rootIdx == -1 {
            return VerifiedChain(pin: pinnedHash, root: nil, rootError: .pinNotInLog,
                                  validMandates: [], rejections: [])
        }

        let root = mandates[rootIdx]
        guard let rw = windowMs(root.issuedAt, root.expiresAt) else {
            return VerifiedChain(pin: pinnedHash, root: nil, rootError: .rootShapeInvalid,
                                  validMandates: [], rejections: [])
        }
        if rw <= 0 {
            return VerifiedChain(pin: pinnedHash, root: nil,
                                  rootError: .rootExpiresBeforeIssuance,
                                  validMandates: [], rejections: [])
        }
        if !allSignaturesValid(root) {
            return VerifiedChain(pin: pinnedHash, root: nil,
                                  rootError: .rootSignatureInvalid,
                                  validMandates: [], rejections: [])
        }
        if !root.signatures.contains(where: { $0.pubkey == root.signedBy }) {
            return VerifiedChain(pin: pinnedHash, root: nil,
                                  rootError: .rootNotSelfSigned,
                                  validMandates: [], rejections: [])
        }

        var accepted: [Mandate] = [root]
        var rejections: [V2Rejection] = []
        var seenIds = Set<String>([root.mandateId])

        var i = rootIdx + 1
        while i < mandates.count {
            let m = mandates[i]
            i += 1
            // Cross-track interleave is legitimate — silently skip a
            // well-formed other-track mandate (mirrors the TS skip).
            if m.track != root.track { continue }
            if seenIds.contains(m.mandateId) {
                rejections.append(V2Rejection(mandate: m, reason: .duplicateMandateId))
                continue
            }
            let pred = accepted[accepted.count - 1]
            if let fail = verifyForwardStep(pred, m) {
                rejections.append(V2Rejection(mandate: m, reason: fail))
            } else {
                accepted.append(m)
                seenIds.insert(m.mandateId)
            }
        }

        return VerifiedChain(pin: pinnedHash, root: root, rootError: nil,
                             validMandates: accepted, rejections: rejections)
    }

    public struct CurrentAuthority: Sendable {
        public let holder: String
        public let mandate: Mandate
        public let successors: [String]
    }

    /// The operational authority at `now`: holder of the most-recent
    /// valid mandate whose [issuedAt, expiresAt) contains `now`. nil ⇒
    /// no live authority (consumers fail closed). Mirrors
    /// `currentAuthority`.
    public static func currentAuthority(_ chain: VerifiedChain, now: Date) -> CurrentAuthority? {
        let nowMs = now.timeIntervalSince1970 * 1000.0
        for m in chain.validMandates.reversed() {
            guard let issued = MaintainersTime.epochMs(m.issuedAt),
                  let expiry = MaintainersTime.epochMs(m.expiresAt) else { continue }
            if issued <= nowMs && nowMs < expiry {
                return CurrentAuthority(holder: m.holder, mandate: m,
                                        successors: m.successors)
            }
        }
        return nil
    }
}

// MARK: - ReleaseEndorsement verification (endorsement.ts)

public enum EndorsementFailReason: String, Sendable {
    case signatureInvalid = "signature-invalid"
    case approvalRuleUnsatisfied = "approval-rule-unsatisfied"
    case signerNotAuthorized = "signer-not-authorized"
    case noAuthorityAtIssuance = "no-authority-at-issuance"
    case merkleRootMismatch = "merkle-root-mismatch"
    case predecessorMismatch = "predecessor-mismatch"
    case genesisMustHaveNoPredecessor = "genesis-must-have-no-predecessor"
    case nonGenesisMustHavePredecessor = "non-genesis-must-have-predecessor"
    case duplicateReleaseId = "duplicate-release-id"
}

public struct VerifiedEndorsements: Sendable {
    public let validEndorsements: [ReleaseEndorsement]
    public let rejections: [(endorsement: ReleaseEndorsement, reason: EndorsementFailReason)]
}

public enum MaintainersReleaseVerifier {

    private static func verifySingle(
        _ e: ReleaseEndorsement,
        prev: ReleaseEndorsement?,
        releaseChain: VerifiedChain,
        seenIds: Set<String>
    ) -> EndorsementFailReason? {
        if seenIds.contains(e.releaseId) { return .duplicateReleaseId }

        if prev == nil {
            if e.previousReleaseId != nil || e.previousCommitHash != nil {
                return .genesisMustHaveNoPredecessor
            }
        } else {
            let p = prev!
            if e.previousReleaseId == nil || e.previousCommitHash == nil {
                return .nonGenesisMustHavePredecessor
            }
            if e.previousReleaseId != p.releaseId || e.previousCommitHash != p.commitHash {
                return .predecessorMismatch
            }
        }

        let expectedRoot: String
        do {
            expectedRoot = try MaintainersCanonical.intermediateMerkleRoot(e.intermediateCommits)
        } catch {
            return .merkleRootMismatch
        }
        if expectedRoot != e.intermediateMerkleRoot { return .merkleRootMismatch }

        let bytes: Data
        do {
            bytes = try MaintainersCanonical.canonicalReleaseEndorsement(e)
        } catch {
            return .signatureInvalid
        }
        for s in e.signatures {
            if !MaintainersEd25519.verify(sigHex: s.sig, message: bytes, pubKeyHex: s.pubkey) {
                return .signatureInvalid
            }
        }

        guard let issuedMs = MaintainersTime.epochMs(e.issuedAt) else {
            return .noAuthorityAtIssuance
        }
        let when = Date(timeIntervalSince1970: issuedMs / 1000.0)
        guard let authority = MaintainersVerifier.currentAuthority(releaseChain, now: when) else {
            return .noAuthorityAtIssuance
        }

        let signerPubkeys = Set(e.signatures.map { $0.pubkey })
        if !signerPubkeys.contains(e.signedBy) { return .signerNotAuthorized }
        if e.signedBy != authority.holder { return .signerNotAuthorized }

        return nil
    }

    /// Mirrors `verifyChainOfEndorsements`. Endorsements MUST be in
    /// canonical-log order (oldest first).
    public static func verifyChainOfEndorsements(
        _ endorsements: [ReleaseEndorsement],
        releaseChain: VerifiedChain
    ) -> VerifiedEndorsements {
        var seenIds = Set<String>()
        var valid: [ReleaseEndorsement] = []
        var rejections: [(endorsement: ReleaseEndorsement, reason: EndorsementFailReason)] = []

        for e in endorsements {
            let prev = valid.last
            if let reason = verifySingle(e, prev: prev, releaseChain: releaseChain, seenIds: seenIds) {
                rejections.append((endorsement: e, reason: reason))
            } else {
                valid.append(e)
                seenIds.insert(e.releaseId)
            }
        }
        return VerifiedEndorsements(validEndorsements: valid, rejections: rejections)
    }
}

// MARK: - CaEndorsement verification (caEndorsement.ts)

public enum CaEndorsementFailReason: String, Sendable {
    case wrongEnvelope = "wrong-envelope"
    case leaseWindowMalformed = "lease-window-malformed"
    case leaseNotYet = "lease-not-yet"
    case leaseExpired = "lease-expired"
    case signatureInvalid = "signature-invalid"
    case noCaAuthorityAtNow = "no-ca-authority-at-now"
    case signerNotAuthorized = "signer-not-authorized"
    case approvalRuleUnsatisfied = "approval-rule-unsatisfied"
}

public struct VerifiedCaEndorsements: Sendable {
    public let validEndorsements: [CaEndorsement]
    public let rejections: [(endorsement: CaEndorsement, reason: CaEndorsementFailReason)]
    public let currentCaPubkey: String?
}

public enum MaintainersCaVerifier {

    /// ±5 min window-edge tolerance — spec §7 default (DEFAULT_CLOCK_SKEW_MS).
    public static let defaultClockSkewMs: Double = 5 * 60 * 1000

    private static func verifyOne(
        _ e: CaEndorsement,
        caChain: VerifiedChain,
        now: Date,
        skewMs: Double
    ) -> CaEndorsementFailReason? {
        if e.kind != "CaEndorsement" || e.version != 1 { return .wrongEnvelope }

        guard let nb = MaintainersTime.epochMs(e.notBefore),
              let na = MaintainersTime.epochMs(e.notAfter), na > nb else {
            return .leaseWindowMalformed
        }
        let nowMs = now.timeIntervalSince1970 * 1000.0
        if nowMs < nb - skewMs { return .leaseNotYet }
        if nowMs >= na + skewMs { return .leaseExpired }

        let bytes: Data
        do {
            bytes = try MaintainersCanonical.canonicalCaEndorsement(e)
        } catch {
            return .signatureInvalid
        }
        for s in e.signatures {
            if !MaintainersEd25519.verify(sigHex: s.sig, message: bytes, pubKeyHex: s.pubkey) {
                return .signatureInvalid
            }
        }

        guard let authority = MaintainersVerifier.currentAuthority(caChain, now: now) else {
            return .noCaAuthorityAtNow
        }
        let signerPubkeys = Set(e.signatures.map { $0.pubkey })
        if !signerPubkeys.contains(e.signedBy) { return .signerNotAuthorized }
        if e.signedBy != authority.holder { return .signerNotAuthorized }
        return nil
    }

    /// Mirrors `verifyCaEndorsements`. Order does not matter; each judged
    /// independently at the verifier's clock `now`.
    public static func verifyCaEndorsements(
        _ endorsements: [CaEndorsement],
        caChain: VerifiedChain,
        now: Date,
        clockSkewMs: Double? = nil
    ) -> VerifiedCaEndorsements {
        let skew = clockSkewMs ?? defaultClockSkewMs
        var valid: [CaEndorsement] = []
        var rejections: [(endorsement: CaEndorsement, reason: CaEndorsementFailReason)] = []

        for e in endorsements {
            if let reason = verifyOne(e, caChain: caChain, now: now, skewMs: skew) {
                rejections.append((endorsement: e, reason: reason))
            } else {
                valid.append(e)
            }
        }

        var current: CaEndorsement?
        for e in valid {
            if current == nil {
                current = e
            } else if let ce = current,
                      let eIss = MaintainersTime.epochMs(e.issuedAt),
                      let cIss = MaintainersTime.epochMs(ce.issuedAt),
                      eIss > cIss {
                current = e
            }
        }

        return VerifiedCaEndorsements(validEndorsements: valid, rejections: rejections,
                                      currentCaPubkey: current?.caPubkey)
    }
}
