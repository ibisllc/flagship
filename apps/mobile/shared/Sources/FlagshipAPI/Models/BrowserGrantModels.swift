import Foundation

// Browser access beyond an app's manifest (SEC-BROWSER-002; packages/server-daemon/src/browser/grantRequests.ts):
//   GET  /api/browser/owner/grant-requests          -> { requests: [...] }
//   POST /api/browser/owner/grant-requests/answer      { requestId, decision, issuedAt, signature?, duration? }
//   GET  /api/browser/owner/grants?serviceId=        -> { grants: [...] }
//   POST /api/browser/owner/grants/revoke              { serviceId, grantId, issuedAt, signature }
// Allow carries a `flagship/browser-grant/v1` signature over what is granted: the ask, for the duration
// the owner chose (the asked one or shorter); Deny none. Withdraw signs `flagship/browser-grant-revoke/v1`.
// A screens-socket frame `{type:"browser-grant-request"}` says an app just asked.

public enum BrowserGrantEvents {
    public static let socketEvent = "browser-grant-request"
    public static let requested = Notification.Name("flagship.browserGrant.requested")

    /// A screens-socket frame `{kind|type|event: "browser-grant-request"}`.
    public static func isRequestFrame(_ data: Data) -> Bool {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return ["kind", "type", "event"].contains { obj[$0] as? String == socketEvent }
    }

    public static func post() {
        NotificationCenter.default.post(name: requested, object: nil)
    }
}

public enum BrowserGrantLocalNetworkWire: Codable, Equatable, Sendable {
    case wholeLan
    case exact([String])

    private enum Keys: String, CodingKey { case kind, hosts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "whole-lan": self = .wholeLan
        case "exact": self = .exact(try c.decode([String].self, forKey: .hosts))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown local-network kind")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .wholeLan: try c.encode("whole-lan", forKey: .kind)
        case .exact(let hosts):
            try c.encode("exact", forKey: .kind)
            try c.encode(hosts, forKey: .hosts)
        }
    }
}

/// One waiting request, as the box normalized it. `meaning` (the box's English) is never shown:
/// the clients say it from these fields in the owner's language.
public struct BrowserGrantRequest: Codable, Equatable, Identifiable, Sendable {
    public let requestId: String
    public let serviceId: String
    public let capabilities: [String]
    public let origins: [String]
    public let localNetwork: BrowserGrantLocalNetworkWire?
    /// "once", "session" or "service".
    public let duration: String
    public let explanation: String?
    public let at: Int64?

    public init(requestId: String, serviceId: String, capabilities: [String], origins: [String],
                localNetwork: BrowserGrantLocalNetworkWire? = nil, duration: String, explanation: String? = nil, at: Int64? = nil) {
        self.requestId = requestId
        self.serviceId = serviceId
        self.capabilities = capabilities
        self.origins = origins
        self.localNetwork = localNetwork
        self.duration = duration
        self.explanation = explanation
        self.at = at
    }

    public var id: String { requestId }
}

public struct BrowserGrantRequestsResponse: Codable, Equatable, Sendable {
    public let requests: [BrowserGrantRequest]
    public init(requests: [BrowserGrantRequest]) { self.requests = requests }
}

public struct BrowserGrantAnswerRequest: Codable, Equatable, Sendable {
    public let requestId: String
    /// "allow" or "deny".
    public let decision: String
    public let issuedAt: Int64
    /// Hex Ed25519 over `flagship/browser-grant/v1`; absent on a denial.
    public let signature: String?
    /// What the owner granted: the asked duration or a shorter one (signed); absent on a denial.
    public let duration: String?

    public init(requestId: String, decision: String, issuedAt: Int64, signature: String? = nil, duration: String? = nil) {
        self.requestId = requestId
        self.decision = decision
        self.issuedAt = issuedAt
        self.signature = signature
        self.duration = duration
    }
}

/// A grant the owner gave (never the manifest's own), still in force.
public struct OwnerBrowserGrant: Codable, Equatable, Identifiable, Sendable {
    public let grantId: String
    public let serviceId: String
    public let capabilities: [String]
    public let origins: [String]
    public let localNetwork: BrowserGrantLocalNetworkWire?
    /// "once", "session" or "service".
    public let duration: String
    public let explanation: String?
    public let issuedAt: Int64?

    public init(grantId: String, serviceId: String, capabilities: [String], origins: [String],
                localNetwork: BrowserGrantLocalNetworkWire? = nil, duration: String, explanation: String? = nil, issuedAt: Int64? = nil) {
        self.grantId = grantId
        self.serviceId = serviceId
        self.capabilities = capabilities
        self.origins = origins
        self.localNetwork = localNetwork
        self.duration = duration
        self.explanation = explanation
        self.issuedAt = issuedAt
    }

    public var id: String { grantId }
}

public struct OwnerBrowserGrantsResponse: Codable, Equatable, Sendable {
    public let grants: [OwnerBrowserGrant]
    public init(grants: [OwnerBrowserGrant]) { self.grants = grants }
}

public struct BrowserGrantRevokeRequest: Codable, Equatable, Sendable {
    public let serviceId: String
    public let grantId: String
    public let issuedAt: Int64
    /// Hex Ed25519 over `flagship/browser-grant-revoke/v1`.
    public let signature: String

    public init(serviceId: String, grantId: String, issuedAt: Int64, signature: String) {
        self.serviceId = serviceId
        self.grantId = grantId
        self.issuedAt = issuedAt
        self.signature = signature
    }
}

// Upstream sync of an imported app (N12; packages/server-daemon/src/buildmodes/syncProposal.ts):
//   POST /api/build/apps/<serviceId>/sync { ref? } -> { ok, buildId, proposal, candidateCommit?, upToDate: false }
//                                                   or { ok, upToDate: true, candidateCommit? } (no build opened)

public struct AppSyncRequest: Codable, Equatable, Sendable {
    public let ref: String?
    public init(ref: String? = nil) { self.ref = ref }
}

public struct SyncCapabilityChange: Codable, Equatable, Hashable, Sendable {
    public let section: String
    public let added: [String]
    public let removed: [String]
    public init(section: String, added: [String], removed: [String]) {
        self.section = section
        self.added = added
        self.removed = removed
    }
}

/// The three-way comparison, without the merged tree (the box keeps it in the build it opened).
public struct SyncProposal: Codable, Equatable, Sendable {
    public let upstreamChanged: [String]
    public let localChanged: [String]
    public let takeUpstream: [String]
    public let conflicts: [String]
    public let alreadyApplied: [String]
    public let capabilityChanges: [SyncCapabilityChange]
    public let clean: Bool

    public init(upstreamChanged: [String] = [], localChanged: [String] = [], takeUpstream: [String] = [],
                conflicts: [String] = [], alreadyApplied: [String] = [], capabilityChanges: [SyncCapabilityChange] = [],
                clean: Bool = true) {
        self.upstreamChanged = upstreamChanged
        self.localChanged = localChanged
        self.takeUpstream = takeUpstream
        self.conflicts = conflicts
        self.alreadyApplied = alreadyApplied
        self.capabilityChanges = capabilityChanges
        self.clean = clean
    }
}

public struct AppSyncResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    /// The build holding the merge; absent when already up to date (the box opens none).
    public let buildId: String?
    public let proposal: SyncProposal?
    public let candidateCommit: String?
    public let upToDate: Bool

    public init(ok: Bool = true, buildId: String?, proposal: SyncProposal?, candidateCommit: String? = nil, upToDate: Bool = false) {
        self.ok = ok
        self.buildId = buildId
        self.proposal = proposal
        self.candidateCommit = candidateCommit
        self.upToDate = upToDate
    }

    private enum Keys: String, CodingKey { case ok, buildId, proposal, candidateCommit, upToDate }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        buildId = try c.decodeIfPresent(String.self, forKey: .buildId)
        proposal = try c.decodeIfPresent(SyncProposal.self, forKey: .proposal)
        candidateCommit = try c.decodeIfPresent(String.self, forKey: .candidateCommit)
        upToDate = try c.decodeIfPresent(Bool.self, forKey: .upToDate) ?? false
        guard upToDate || (buildId != nil && proposal != nil) else {
            throw DecodingError.dataCorruptedError(forKey: .buildId, in: c, debugDescription: "a proposal needs its build")
        }
    }
}
