import Foundation

/// Wire records of the serving authority (the owner's single dead-man setting); the signing rules live in
/// FlagshipCore `ServingAuthority.swift`, byte-identical to `packages/protocol/src/servingAuthority.ts`.
public enum ServingGrace: String, Codable, Sendable, CaseIterable, Equatable {
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case indefinite

    /// Milliseconds of the grace; nil for indefinite.
    public var ms: Int64? {
        switch self {
        case .sevenDays: return 7 * 86_400_000
        case .thirtyDays: return 30 * 86_400_000
        case .indefinite: return nil
        }
    }
}

public enum ServingOnLapse: String, Codable, Sendable, CaseIterable, Equatable {
    case stopApps = "stop-apps"
    case lockServer = "lock-server"
}

public enum ServingRecordError: Error, Equatable {
    case invalid(String)
}

public struct ServingPolicy: Codable, Equatable, Sendable {
    public static let tag = "flagship/serving-policy/v1"
    public var account: String
    public var box: String
    public var regGen: Int64
    public var policyGen: Int64
    public var grace: String
    public var onLapse: String
    public var scopeSha256: String
    public var issuedAt: Int64

    public init(account: String, box: String, regGen: Int64, policyGen: Int64, grace: ServingGrace,
                onLapse: ServingOnLapse, scopeSha256: String, issuedAt: Int64) {
        self.account = account; self.box = box; self.regGen = regGen; self.policyGen = policyGen
        self.grace = grace.rawValue; self.onLapse = onLapse.rawValue; self.scopeSha256 = scopeSha256; self.issuedAt = issuedAt
    }

    public var graceValue: ServingGrace? { ServingGrace(rawValue: grace) }
    public var onLapseValue: ServingOnLapse? { ServingOnLapse(rawValue: onLapse) }
}

public struct RenewalKeyDelegation: Codable, Equatable, Sendable {
    public static let tag = "flagship/renewal-key-delegation/v1"
    public var account: String
    public var alg: String
    /// SEC1 compressed P-256 point, 66 lowercase hex.
    public var renewalPub: String
    /// The device's account device key (64 hex).
    public var deviceId: String
    public var issuedAt: Int64

    public init(account: String, renewalPub: String, deviceId: String, issuedAt: Int64) {
        self.account = account; self.alg = "p256"; self.renewalPub = renewalPub; self.deviceId = deviceId; self.issuedAt = issuedAt
    }
}

public struct ServingLease: Codable, Equatable, Sendable {
    public static let tag = "flagship/serving-lease/v1"
    public var account: String
    public var box: String
    public var regGen: Int64
    public var policyGen: Int64
    /// 32 lowercase hex, unique per lease.
    public var leaseId: String
    public var issuedAt: Int64
    public var notAfter: Int64

    public init(account: String, box: String, regGen: Int64, policyGen: Int64, leaseId: String, issuedAt: Int64, notAfter: Int64) {
        self.account = account; self.box = box; self.regGen = regGen; self.policyGen = policyGen
        self.leaseId = leaseId; self.issuedAt = issuedAt; self.notAfter = notAfter
    }
}

/// A record with its signature, the shape the box keeps and the relay decides on (`SignedServingRecord`).
public struct SignedServingRecord<T: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var record: T
    public var signature: String
    public init(record: T, signature: String) { self.record = record; self.signature = signature }
}

/// A lease with the delegation of the key that signed it (absent when the admin root signed it).
public struct SignedServingLease: Codable, Equatable, Sendable {
    public var record: ServingLease
    public var signature: String
    public var delegation: SignedServingRecord<RenewalKeyDelegation>?
    public init(record: ServingLease, signature: String, delegation: SignedServingRecord<RenewalKeyDelegation>? = nil) {
        self.record = record; self.signature = signature; self.delegation = delegation
    }
}

/// `POST /api/accounts/:u/serving-policy`.
public struct ServingPolicyPost: Codable, Equatable, Sendable {
    public var policy: ServingPolicy
    public var signature: String
    public init(policy: ServingPolicy, signature: String) { self.policy = policy; self.signature = signature }
}

/// `POST /api/accounts/:u/renewal-delegations`.
public struct RenewalDelegationPost: Codable, Equatable, Sendable {
    public var delegation: RenewalKeyDelegation
    public var signature: String
    public init(delegation: RenewalKeyDelegation, signature: String) { self.delegation = delegation; self.signature = signature }
}

/// `POST /api/accounts/:u/serving-leases`: `{leases: [{lease, signature, delegationPub?}]}`.
public struct ServingLeasesPost: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public var lease: ServingLease
        public var signature: String
        /// The renewal key that signed it; absent when the admin root signed it.
        public var delegationPub: String?
        public init(lease: ServingLease, signature: String, delegationPub: String?) {
            self.lease = lease; self.signature = signature; self.delegationPub = delegationPub
        }
    }
    public var leases: [Item]
    public init(leases: [Item]) { self.leases = leases }
}

public struct ServingLeasesResult: Codable, Equatable, Sendable {
    public struct Refused: Codable, Equatable, Sendable {
        public var leaseId: String
        public var code: String
        public init(leaseId: String, code: String) { self.leaseId = leaseId; self.code = code }
    }
    public var accepted: Int
    public var refused: [Refused]
    public init(accepted: Int, refused: [Refused] = []) { self.accepted = accepted; self.refused = refused }
}

/// A lease as the box takes it: the renewal key that signed it is named, its delegation sent alongside.
public struct BoxServingLease: Codable, Equatable, Sendable {
    public var record: ServingLease
    public var signature: String
    public var delegationPub: String?
    public init(record: ServingLease, signature: String, delegationPub: String? = nil) {
        self.record = record; self.signature = signature; self.delegationPub = delegationPub
    }
}

/// `POST /api/screens/serving` on the box: any of the records, each verified there before it is kept.
/// Answers `{ok, policyAdopted, leasesAccepted, refused:[{kind, leaseId?, code}], serving}`.
public struct BoxServingPost: Codable, Equatable, Sendable {
    public var policy: SignedServingRecord<ServingPolicy>?
    public var leases: [BoxServingLease]?
    public var delegations: [SignedServingRecord<RenewalKeyDelegation>]?
    public init(policy: SignedServingRecord<ServingPolicy>? = nil, leases: [BoxServingLease]? = nil,
                delegations: [SignedServingRecord<RenewalKeyDelegation>]? = nil) {
        self.policy = policy; self.leases = leases; self.delegations = delegations
    }
}

/// server-detail `serving`: the line on the server page, and what a policy edit is signed against.
public struct ServingView: Codable, Equatable, Sendable {
    public var grace: String
    public var onLapse: String
    /// When app routes stop without a newer lease; nil: no time limit.
    public var until: Int64?
    public var policyGen: Int64
    public var regGen: Int64
    public var scopeSha256: String
    /// The box identity key a policy names (absent from the earliest builds of the route).
    public var boxPub: String?
    public init(grace: String, onLapse: String, until: Int64?, policyGen: Int64, regGen: Int64, scopeSha256: String, boxPub: String? = nil) {
        self.grace = grace; self.onLapse = onLapse; self.until = until
        self.policyGen = policyGen; self.regGen = regGen; self.scopeSha256 = scopeSha256; self.boxPub = boxPub
    }
    public var graceValue: ServingGrace { ServingGrace(rawValue: grace) ?? .indefinite }
    public var onLapseValue: ServingOnLapse { ServingOnLapse(rawValue: onLapse) ?? .stopApps }
}

/// `GET /api/accounts/:u/serving`, one entry per server of the account.
public struct AccountServingEntry: Codable, Equatable, Sendable {
    public var serverDomain: String
    public var boxPub: String
    public var regGen: Int64
    public var policy: SignedServingRecord<ServingPolicy>?
    public var until: Int64?
    public var onLapse: String?
    public var grace: String?
    public var confirmedByRelays: Bool?
    public init(serverDomain: String, boxPub: String, regGen: Int64, policy: SignedServingRecord<ServingPolicy>? = nil,
                until: Int64? = nil, onLapse: String? = nil, grace: String? = nil, confirmedByRelays: Bool? = nil) {
        self.serverDomain = serverDomain; self.boxPub = boxPub; self.regGen = regGen; self.policy = policy
        self.until = until; self.onLapse = onLapse; self.grace = grace; self.confirmedByRelays = confirmedByRelays
    }
}

public struct AccountServingResponse: Codable, Equatable, Sendable {
    public var servers: [AccountServingEntry]
    public init(servers: [AccountServingEntry]) { self.servers = servers }
}
