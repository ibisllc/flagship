import Foundation
import CryptoKit

/// Strict quantum-resistant vs Compatibility, per scope: the Swift twin of
/// packages/protocol/src/assurancePolicy.ts (codes, canonical bytes and rules identical; shared
/// vectors in test-vectors/assurance-policy/). A profile only changes through an owner-signed,
/// generation-chained change; rollout only moves forward; a strict scope can only be weakened
/// by a signer that itself meets strict.
public enum AssuranceProfile: String, Codable, Sendable { case strict, compatibility }

public enum PolicyScopeKind: String, Codable, CaseIterable, Sendable {
    case installation, service, data, connector, device
}

public enum RolloutState: String, Codable, CaseIterable, Sendable {
    case legacy, capable, prepared, enforced, retired
    var rank: Int { Self.allCases.firstIndex(of: self)! }
}

public enum SignatureSuite: String, Codable, Sendable {
    case ed25519 = "ed25519/v1"
    case hybrid = "hybrid-ed25519-mldsa65/v1"
}

public enum PolicySignerKind: String, Codable, Sendable {
    case adminDevice = "admin-device", adminRoot = "admin-root", box, app, relay, cloud, legacyClient = "legacy-client"
}

public struct PolicyScope: Codable, Equatable, Hashable, Sendable {
    public var kind: PolicyScopeKind
    public var id: String
    public init(kind: PolicyScopeKind, id: String) { self.kind = kind; self.id = id }
}

public struct StrictReentryEvidence: Codable, Equatable, Sendable {
    public var verifierChecksDigest: String
    public var enrollmentDigest: String
    public var rekeyReceiptDigest: String
    public var recoveryTestDigest: String
}

public struct AssurancePolicyChange: Codable, Equatable, Sendable {
    public var account: String
    public var scope: PolicyScope
    public var prior: AssuranceProfile
    public var next: AssuranceProfile
    public var generation: Int
    public var prevDigest: String
    public var affectedPeersDigest: String
    /// What the owner was told they give up (`AssurancePolicy.protectionLossCodes`).
    public var acknowledgedLoss: [String]
    public var reentry: StrictReentryEvidence?
    public var signerKind: PolicySignerKind
    public var signerKeyId: String
    public var suite: SignatureSuite
    public var issuedAt: Int64
}

public struct PolicyState: Codable, Equatable, Sendable {
    public var scope: PolicyScope
    public var profile: AssuranceProfile
    public var rollout: RolloutState
    public var generation: Int
    public var headDigest: String
    /// Once a scope has been enforced, coming back to strict needs the re-entry evidence.
    public var enforcedEver: Bool

    public init(scope: PolicyScope, profile: AssuranceProfile, rollout: RolloutState, generation: Int, headDigest: String, enforcedEver: Bool) {
        self.scope = scope; self.profile = profile; self.rollout = rollout; self.generation = generation
        self.headDigest = headDigest; self.enforcedEver = enforcedEver
    }
}

public struct PolicyError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
    public var description: String { "\(code): \(message)" }
}

public struct RolloutEvidence: Sendable {
    public var capabilityAdvertised = false
    public var boundPublicKeys = false
    public var recipientsVerified = false
    public var recoveryChecked = false
    public var compatibilityGatePassed = false
    public init(capabilityAdvertised: Bool = false, boundPublicKeys: Bool = false, recipientsVerified: Bool = false,
                recoveryChecked: Bool = false, compatibilityGatePassed: Bool = false) {
        self.capabilityAdvertised = capabilityAdvertised; self.boundPublicKeys = boundPublicKeys
        self.recipientsVerified = recipientsVerified; self.recoveryChecked = recoveryChecked
        self.compatibilityGatePassed = compatibilityGatePassed
    }
}

public struct ExportAuthorization: Sendable {
    public var subjectDigest: String
    public var generation: Int
}

public enum AssurancePolicy {
    public static let tag = "flagship/assurance-policy/v1"
    public static let protectionLossCodes = [
        "classical-signatures-accepted", "classical-key-exchange-accepted", "browser-without-pq-authentication",
        "connector-classical-last-leg", "firmware-root-classical", "legacy-recovery-path",
    ]
    public static let maxGeneration = Int(Int32.max)
    public static let genesisDigest = String(repeating: "0", count: 64)

    static func isHex64(_ s: String) -> Bool { s.utf8.count == 64 && PqBin.isLowerHex(s) }
    static func isKeyId(_ s: String) -> Bool { (16...128).contains(s.utf8.count) && s.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) } }

    static func assertCanonicalField(_ v: String, _ field: String) throws {
        if v.isEmpty { throw PolicyError("malformed", "assurance-policy: empty \"\(field)\"") }
        for u in v.utf16 where u == 0x7c || u <= 0x1f || u == 0x7f {
            throw PolicyError("malformed", "assurance-policy field \"\(field)\" contains a separator or control char")
        }
    }

    public static func canonical(_ c: AssurancePolicyChange) throws -> [UInt8] {
        try assertCanonicalField(c.account, "account")
        try assertCanonicalField(c.scope.id, "scope.id")
        if c.generation < 1 || c.generation > maxGeneration { throw PolicyError("malformed", "assurance-policy: bad generation") }
        if c.issuedAt < 0 || c.issuedAt > (1 << 53) - 1 { throw PolicyError("malformed", "assurance-policy: bad issuedAt") }
        if !isHex64(c.prevDigest) { throw PolicyError("malformed", "assurance-policy: prevDigest must be 32-byte hex") }
        if !isHex64(c.affectedPeersDigest) { throw PolicyError("malformed", "assurance-policy: affectedPeersDigest must be 32-byte hex") }
        if !isKeyId(c.signerKeyId) { throw PolicyError("malformed", "assurance-policy: bad signerKeyId") }
        let loss = Array(Set(c.acknowledgedLoss)).sorted()
        if loss.count != c.acknowledgedLoss.count { throw PolicyError("malformed", "assurance-policy: repeated loss code") }
        for l in loss where !protectionLossCodes.contains(l) { throw PolicyError("malformed", "assurance-policy: unknown loss code") }
        var reentry = "-"
        if let r = c.reentry {
            let all = [r.verifierChecksDigest, r.enrollmentDigest, r.rekeyReceiptDigest, r.recoveryTestDigest]
            if !all.allSatisfy(isHex64) { throw PolicyError("malformed", "assurance-policy: reentry digests must be 32-byte hex") }
            reentry = all.joined(separator: ",")
        }
        let text = [
            tag, c.account, c.scope.kind.rawValue, c.scope.id, c.prior.rawValue, c.next.rawValue, String(c.generation),
            c.prevDigest, c.affectedPeersDigest, loss.isEmpty ? "-" : loss.joined(separator: ","), reentry,
            c.signerKind.rawValue, c.signerKeyId, c.suite.rawValue, String(c.issuedAt),
        ].joined(separator: "|")
        return Array(text.utf8)
    }

    public static func digest(_ c: AssurancePolicyChange) throws -> String {
        PqBin.hex(Array(SHA256.hash(data: try canonical(c))))
    }

    /// An existing installation before any migration: classical accepted, nothing enforced.
    public static func legacyState(_ scope: PolicyScope) -> PolicyState {
        PolicyState(scope: scope, profile: .compatibility, rollout: .legacy, generation: 0, headDigest: genesisDigest, enforcedEver: false)
    }

    /// True when this scope's strict profile is in force: classical-only messages are refused.
    public static func strictInForce(_ s: PolicyState) -> Bool {
        s.profile == .strict && (s.rollout == .enforced || s.rollout == .retired)
    }

    public static func acceptsClassicalOnly(_ s: PolicyState) -> Bool { !strictInForce(s) }

    /// Verifies the change's signature with the suite it names, and whether the signer is an
    /// active, unrevoked native authority of the account. `suiteVerified` only for the suite named.
    public typealias SignatureCheck = (_ msg: [UInt8], _ change: AssurancePolicyChange) -> (suiteVerified: Bool, signerActive: Bool)

    public static func apply(_ state: PolicyState, _ change: AssurancePolicyChange, check: SignatureCheck) throws -> PolicyState {
        if change.scope != state.scope { throw PolicyError("wrong-scope", "the change is for another scope") }
        if change.generation <= state.generation { throw PolicyError("stale-generation", "the change is older than the policy in force") }
        if change.generation != state.generation + 1 { throw PolicyError("stale-generation", "the change skips a generation") }
        if change.prevDigest != state.headDigest { throw PolicyError("broken-chain", "the change does not follow the policy in force") }
        if change.prior != state.profile { throw PolicyError("wrong-prior", "the change starts from another profile") }
        if change.next == change.prior { throw PolicyError("no-change", "the change does not change the profile") }
        if change.signerKind != .adminDevice && change.signerKind != .adminRoot {
            throw PolicyError("not-owner-authority", "only the owner's admin device or admin root can change protection")
        }
        let msg = try canonical(change)
        let verdict = check(msg, change)
        if !verdict.suiteVerified { throw PolicyError("bad-signature", "the signature does not verify") }
        if !verdict.signerActive { throw PolicyError("signer-not-active", "the signer is not an active device of the account") }
        if strictInForce(state) && change.suite != .hybrid {
            throw PolicyError("classical-signer-refused", "a strict scope can only be changed by a signer that meets strict")
        }
        if change.next == .compatibility {
            if change.acknowledgedLoss.isEmpty { throw PolicyError("loss-not-acknowledged", "the owner must be told what protection is lost") }
        } else {
            if change.suite != .hybrid { throw PolicyError("classical-signer-refused", "turning on strict needs a strict signer") }
            if state.rollout == .legacy || state.rollout == .capable { throw PolicyError("not-prepared", "new keys, recipients and recovery are not ready") }
            if state.enforcedEver && change.reentry == nil {
                throw PolicyError("reentry-incomplete", "returning to strict needs fresh checks, enrollment, rekeying and a tested recovery")
            }
        }
        let rollout: RolloutState = change.next == .strict && state.rollout == .prepared ? .enforced : state.rollout
        return PolicyState(scope: state.scope, profile: change.next, rollout: rollout, generation: change.generation,
                           headDigest: try digest(change),
                           enforcedEver: state.enforcedEver || rollout == .enforced || rollout == .retired)
    }

    /// Moves a scope's rollout forward by evidence. Enforcement itself only comes from a policy change.
    public static func advanceRollout(_ state: PolicyState, to: RolloutState, evidence ev: RolloutEvidence) throws -> PolicyState {
        if to.rank <= state.rollout.rank { throw PolicyError("rollback-refused", "rollout cannot go from \(state.rollout.rawValue) to \(to.rawValue)") }
        if to.rank != state.rollout.rank + 1 { throw PolicyError("missing-evidence", "rollout moves one step at a time") }
        switch to {
        case .capable:
            if !ev.capabilityAdvertised { throw PolicyError("missing-evidence", "no capability advertisement") }
        case .prepared:
            if !(ev.boundPublicKeys && ev.recipientsVerified && ev.recoveryChecked) {
                throw PolicyError("missing-evidence", "prepared needs bound keys, verified recipients and a recovery check")
            }
        case .enforced:
            throw PolicyError("needs-policy-change", "enforcement needs the owner's signed change to strict")
        case .retired:
            if state.profile != .strict || !ev.compatibilityGatePassed {
                throw PolicyError("missing-evidence", "retiring old readers needs strict in force and the compatibility gate passed")
            }
        case .legacy:
            break
        }
        var s = state
        s.rollout = to
        return s
    }

    /// Taking a stored state (restore, reboot, a copy from another device) never moves backwards.
    public static func adoptStoredState(current: PolicyState?, stored: PolicyState) throws -> PolicyState {
        guard let current else { return stored }
        if stored.scope != current.scope { throw PolicyError("wrong-scope", "stored state is for another scope") }
        let older = stored.generation < current.generation
            || stored.rollout.rank < current.rollout.rank
            || (stored.generation == current.generation && stored.headDigest != current.headDigest)
            || (current.enforcedEver && !stored.enforcedEver)
        if older { throw PolicyError("rollback-refused", "the stored policy is older than the one in force") }
        return stored
    }

    /// Picks the signature suite. Stripping the hybrid suite from an offer cannot downgrade a strict scope.
    public static func selectSignatureSuite(_ state: PolicyState, offered: [SignatureSuite]) throws -> SignatureSuite {
        if offered.contains(.hybrid) { return .hybrid }
        if strictInForce(state) { throw PolicyError("upgrade-required", "this scope needs a quantum-resistant signature; update the app on that device") }
        if offered.contains(.ed25519) { return .ed25519 }
        throw PolicyError("upgrade-required", "no signature suite in common")
    }

    /// Two scopes exchanging data over a classical-only channel: the stricter side decides.
    public static func classicalExchangeAllowed(_ a: PolicyState, _ b: PolicyState, subjectDigest: String, auth: ExportAuthorization?) -> Bool {
        if !strictInForce(a) && !strictInForce(b) { return true }
        guard let auth else { return false }
        return auth.subjectDigest == subjectDigest && isHex64(subjectDigest)
    }

    // MARK: Served chains

    /// One link of a chain as `.com` serves it.
    public struct SignedChange: Codable, Equatable, Sendable {
        public var change: AssurancePolicyChange
        public var signature: SignatureEnvelope
        public init(change: AssurancePolicyChange, signature: SignatureEnvelope) { self.change = change; self.signature = signature }
    }

    /// Replays a served chain on top of `start` (rollout evidence already applied by the caller):
    /// each change must follow the last one and pass `check`. The result is then adopted over
    /// `current` (what this device already holds), so a shorter or forked chain is refused.
    public static func replay(chain: [SignedChange], start: PolicyState, current: PolicyState?,
                              check: (_ msg: [UInt8], _ link: SignedChange, _ stateBefore: PolicyState) -> (suiteVerified: Bool, signerActive: Bool)) throws -> PolicyState {
        var s = start
        for link in chain {
            let before = s
            s = try apply(s, link.change) { msg, _ in check(msg, link, before) }
        }
        return try adoptStoredState(current: current, stored: s)
    }

    /// The signature check for a served link, through the critical-signature gate: the signer's
    /// Ed25519 key is `signerKeyId`; `binding` is its verified PQ binding (or nil); `signerActive`
    /// is the caller's own view of whether that key is a live admin of the account.
    public static func gateCheck(_ msg: [UInt8], _ link: SignedChange, stateBefore: PolicyState,
                                 binding: VerifiedPqKeyBinding?, signerActive: Bool) -> (suiteVerified: Bool, signerActive: Bool) {
        guard link.signature.suite == link.change.suite.rawValue,
              let v = try? PqTrust.verifyCriticalSignature(message: msg, expectedPurpose: tag, envelope: link.signature,
                                                            signerEd25519PubHex: link.change.signerKeyId, binding: binding,
                                                            policy: stateBefore)
        else { return (false, signerActive) }
        return (v.suite == link.change.suite, signerActive)
    }
}
