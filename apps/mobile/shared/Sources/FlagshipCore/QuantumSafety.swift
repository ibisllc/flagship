import Foundation
import CryptoKit

/// Architecture v2 milestone 4: the owner's strict opt-in on the phone
/// (docs/architecture-v2/pq-suites.md §13.6 and IMPLEMENTATION-PLAN.md §3.1).
///
/// The phone replays every scope's served chain under keys it trusts and keeps the newest
/// verified state per scope, refusing a chain older than the one it holds (anti-rollback).
/// Turning strict on, the owner answers per server or app whether browsers may still reach it;
/// a "yes" is the loss code `browser-without-pq-authentication` signed into the change itself,
/// so the box enforces exactly what the owner saw. Leaving strict names what is given up.
public enum QuantumSafety {
    public static let browserLoss = "browser-without-pq-authentication"
    public static let connectorLoss = "connector-classical-last-leg"
    public static let leavingStrictLoss = ["classical-signatures-accepted", "classical-key-exchange-accepted", browserLoss]

    /// The sentence each loss code stands for, shown before the owner signs.
    public static func lossText(_ code: String) -> String {
        switch code {
        case "classical-signatures-accepted": return "Orders signed only with today's (classical) signatures will be accepted again."
        case "classical-key-exchange-accepted": return "Connections that use only classical key exchange will be accepted again."
        case browserLoss: return "Browsers can reach it. A browser's connection uses post-quantum key exchange, but the server's identity is still proven with a classical certificate."
        case connectorLoss: return "This service's own connection is classical, so what it is sent could be read by a future quantum computer."
        case "firmware-root-classical": return "The server's firmware and boot chain are still checked with classical keys."
        case "legacy-recovery-path": return "An older recovery path that is not quantum-safe stays open."
        default: return code
        }
    }

    /// SHA-256 of the sorted, distinct, lower-case peer subjects joined by `|` (the servers or
    /// devices whose protection the change moves); every port computes it the same way.
    public static func affectedPeersDigest(_ peers: [String]) -> String {
        let joined = Array(Set(peers.map { $0.lowercased() })).sorted().joined(separator: "|")
        return SHA256.hash(data: Data(joined.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - The served chain

    public struct Replayed: Equatable, Sendable {
        public let state: PolicyState
        /// What the owner acknowledged in the change in force.
        public let headLoss: [String]

        /// Under strict, whether a browser may still reach the scope (the owner's answer).
        public var browsersAllowed: Bool { !AssurancePolicy.strictInForce(state) || headLoss.contains(QuantumSafety.browserLoss) }
    }

    /// Replays `chain` from legacy and adopts it over `current`. Each change must be signed by
    /// the pinned admin root or an admin device the caller trusts, through the gate under its
    /// verified binding. Rollout evidence comes from the owner's own act: a change to strict is
    /// only signed after the readiness check, and the box checks its own evidence again.
    public static func replay(scope: PolicyScope, account: String, chain: [AssurancePolicy.SignedChange], current: PolicyState?,
                              adminRootHex: String?, isAdminDevice: (String) -> Bool,
                              bindingFor: (String) -> VerifiedPqKeyBinding?) throws -> Replayed {
        var s = AssurancePolicy.legacyState(scope)
        var loss: [String] = []
        let ready = RolloutEvidence(capabilityAdvertised: true, boundPublicKeys: true, recipientsVerified: true, recoveryChecked: true)
        for link in chain {
            guard link.change.account == account.lowercased(), link.change.scope == scope else { throw PolicyError("wrong-scope", "the change is for another scope") }
            if link.change.next == .strict {
                if s.rollout == .legacy { s = try AssurancePolicy.advanceRollout(s, to: .capable, evidence: ready) }
                if s.rollout == .capable { s = try AssurancePolicy.advanceRollout(s, to: .prepared, evidence: ready) }
            }
            let before = s
            let key = link.change.signerKeyId.lowercased()
            let active = link.change.signerKind == .adminRoot ? key == adminRootHex?.lowercased() : (link.change.signerKind == .adminDevice && isAdminDevice(key))
            s = try AssurancePolicy.apply(s, link.change) { msg, _ in
                AssurancePolicy.gateCheck(msg, link, stateBefore: before, binding: bindingFor(key), signerActive: active)
            }
            loss = link.change.acknowledgedLoss
        }
        return Replayed(state: try AssurancePolicy.adoptStoredState(current: current, stored: s), headLoss: loss)
    }

    /// What this device holds per scope; a stored state is never replaced by an older one.
    public final class Store: @unchecked Sendable {
        private let defaults: UserDefaults
        private let lock = NSLock()
        private static let prefix = "flagship.assurance.v1."

        public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

        private func key(_ account: String, _ s: PolicyScope) -> String { "\(Self.prefix)\(account.lowercased())|\(s.kind.rawValue)|\(s.id)" }

        private struct Saved: Codable { let state: PolicyState; let headLoss: [String] }

        public func replayed(account: String, scope: PolicyScope) -> Replayed? {
            lock.lock(); defer { lock.unlock() }
            guard let d = defaults.data(forKey: key(account, scope)), let s = try? JSONDecoder().decode(Saved.self, from: d) else { return nil }
            return Replayed(state: s.state, headLoss: s.headLoss)
        }

        /// Keeps `r` unless it is older than what is held (then throws `rollback-refused`).
        public func adopt(account: String, _ r: Replayed) throws {
            lock.lock(); defer { lock.unlock() }
            let k = key(account, r.state.scope)
            if let d = defaults.data(forKey: k), let held = try? JSONDecoder().decode(Saved.self, from: d) {
                _ = try AssurancePolicy.adoptStoredState(current: held.state, stored: r.state)
            }
            defaults.set(try JSONEncoder().encode(Saved(state: r.state, headLoss: r.headLoss)), forKey: k)
        }

        /// Forgets every scope of the account (sign out, wipe, removing this device).
        public func forget(account: String) {
            lock.lock(); defer { lock.unlock() }
            let p = "\(Self.prefix)\(account.lowercased())|"
            for k in defaults.dictionaryRepresentation().keys where k.hasPrefix(p) { defaults.removeObject(forKey: k) }
        }

        /// True when any scope this device holds for the account is strict in force.
        public func anyStrict(account: String) -> Bool {
            lock.lock(); defer { lock.unlock() }
            let p = "\(Self.prefix)\(account.lowercased())|"
            return defaults.dictionaryRepresentation().contains { k, v in
                guard k.hasPrefix(p), let d = v as? Data, let s = try? JSONDecoder().decode(Saved.self, from: d) else { return false }
                return AssurancePolicy.strictInForce(s.state)
            }
        }
    }

    // MARK: - Changes the owner signs

    /// The change that turns strict on. `browsersAllowed` is the owner's explicit answer; there
    /// is no default, so the caller cannot build the change before it is given.
    public static func strictChange(account: String, scope: PolicyScope, from state: PolicyState, browsersAllowed: Bool,
                                    peers: [String], signerKind: PolicySignerKind, signerKeyId: String, now: Int64) -> AssurancePolicyChange {
        AssurancePolicyChange(account: account.lowercased(), scope: scope, prior: state.profile, next: .strict,
                              generation: state.generation + 1, prevDigest: state.headDigest,
                              affectedPeersDigest: affectedPeersDigest(peers),
                              acknowledgedLoss: browsersAllowed ? [browserLoss] : [], reentry: nil,
                              signerKind: signerKind, signerKeyId: signerKeyId.lowercased(), suite: .hybrid, issuedAt: now)
    }

    /// The change back to compatibility, naming every loss the owner read and accepted.
    public static func compatibilityChange(account: String, scope: PolicyScope, from state: PolicyState, loss: [String],
                                           peers: [String], signerKind: PolicySignerKind, signerKeyId: String, now: Int64) -> AssurancePolicyChange {
        AssurancePolicyChange(account: account.lowercased(), scope: scope, prior: state.profile, next: .compatibility,
                              generation: state.generation + 1, prevDigest: state.headDigest,
                              affectedPeersDigest: affectedPeersDigest(peers), acknowledgedLoss: Array(Set(loss)).sorted(), reentry: nil,
                              signerKind: signerKind, signerKeyId: signerKeyId.lowercased(), suite: .hybrid, issuedAt: now)
    }

    /// The hybrid AND-signature over `message` (purpose = its own tag) with the identity's
    /// Ed25519 key and its ML-DSA key from the PQ key store.
    public static func hybridEnvelope(message: [UInt8], edPublicKey: [UInt8], edSign: ([UInt8]) throws -> [UInt8], held: PqHeldKey) throws -> SignatureEnvelope {
        let purpose = PqTrust.messagePurpose(message)
        let sig = try PqHybrid.hybridSign(edPublicKey: edPublicKey, mldsaPublicKey: PqBin.unhex(held.mldsaPubHex) ?? [], purpose: purpose,
                                          payload: message, edSign: edSign, mldsaSign: held.sign)
        return SignatureEnvelope(suite: SignatureSuite.hybrid.rawValue, signature: PqBin.hex(sig))
    }

    // MARK: - Readiness

    public struct Readiness: Equatable, Sendable {
        public var devicesBound: Int
        public var devices: Int
        public var thisDeviceBound: Bool
        public var thisDeviceIsAdmin: Bool
        public var recoveryChecked: Bool
        public var serverBound: Bool

        public init(devicesBound: Int, devices: Int, thisDeviceBound: Bool, thisDeviceIsAdmin: Bool, recoveryChecked: Bool, serverBound: Bool) {
            self.devicesBound = devicesBound; self.devices = devices; self.thisDeviceBound = thisDeviceBound
            self.thisDeviceIsAdmin = thisDeviceIsAdmin; self.recoveryChecked = recoveryChecked; self.serverBound = serverBound
        }

        public var ready: Bool { thisDeviceIsAdmin && thisDeviceBound && devicesBound == devices && devices > 0 && recoveryChecked && serverBound }

        /// What is still missing, one sentence each, in the order to fix them.
        public var missing: [String] {
            var out: [String] = []
            if !thisDeviceIsAdmin { out.append("Only an admin device of this account can turn this on.") }
            if !thisDeviceBound { out.append("This device's post-quantum key isn't registered yet. Unlock the app once while online.") }
            if devicesBound < devices { out.append("\(devices - devicesBound) of your devices have no post-quantum key yet. Open Flagship on each of them, or remove the ones you no longer use.") }
            if !recoveryChecked { out.append("Save and test your account recovery first.") }
            if !serverBound { out.append("This server hasn't registered its post-quantum key yet. Update it first.") }
            return out
        }
    }

    // MARK: - Connectors

    public enum Protection: String, Sendable {
        /// The content is sealed end to end with post-quantum keys.
        case pqEndToEnd
        /// The connection to the provider is classical (its own TLS).
        case classical
        /// Nothing private is sent (a content-free wake-up).
        case contentFree

        public var label: String {
            switch self {
            case .pqEndToEnd: return "Quantum-safe"
            case .classical: return "Classical connection"
            case .contentFree: return "Content-free"
            }
        }
    }

    public struct Connector: Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let detail: String
        public let protection: Protection
        public init(id: String, name: String, detail: String, protection: Protection) {
            self.id = id; self.name = name; self.detail = detail; self.protection = protection
        }
        /// Content-free pushes stay allowed in strict; every other classical connector needs the owner's choice.
        public var needsChoice: Bool { protection == .classical }
    }

    /// The services a server sends things to: each AI provider (Flagship Inference and the
    /// owner's own keys) and the push services.
    public static func connectors(aiProviders: [String]) -> [Connector] {
        var out = [Connector(id: "ai-flagship-inference", name: "Flagship Inference", detail: "Builds your apps with a hosted model. Prompts and code go over the provider's own TLS.", protection: .classical)]
        for p in Array(Set(aiProviders.map { $0.lowercased() })).sorted() where p != "flagship-inference" {
            out.append(Connector(id: "ai-\(p)", name: p.capitalized, detail: "Your own AI key. Prompts and code go over the provider's own TLS.", protection: .classical))
        }
        out.append(Connector(id: "push-apns", name: "Apple push", detail: "Wakes the app. Carries no content; the app then asks the server over the quantum-safe channel.", protection: .contentFree))
        out.append(Connector(id: "push-fcm", name: "Google push", detail: "Wakes the app. Carries no content; the app then asks the server over the quantum-safe channel.", protection: .contentFree))
        return out
    }

    /// A connector's scope: `<serverDomain>:<connector id>`.
    public static func connectorScope(server: String, connector: String) -> PolicyScope {
        PolicyScope(kind: .connector, id: "\(server.lowercased()):\(connector)")
    }

    /// An app's scope: `<serverDomain>:<service id>`.
    public static func serviceScope(server: String, service: String) -> PolicyScope {
        PolicyScope(kind: .service, id: "\(server.lowercased()):\(service)")
    }
}
