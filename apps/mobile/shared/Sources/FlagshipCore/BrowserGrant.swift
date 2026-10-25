import CryptoKit
import Foundation

/// `flagship/browser-grant/v1`: the owner's answer to an app's request for browser access beyond its
/// manifest, signed with the sensitive-order key and posted to `POST /api/browser/owner/grant-requests/answer`.
/// Wire parity with packages/protocol/src/browserGrant.ts; pinned by
/// packages/protocol/test-vectors/browser-grant/vectors.json.
public struct BrowserGrantAnswer: Equatable, Sendable {
    public static let canonicalTag = "flagship/browser-grant/v1"
    public enum LocalNetwork: Equatable, Sendable { case none, wholeLan, exact([String]) }
    public struct Invalid: Error, Equatable { public let reason: String }

    public let serverDomain: String
    public let requestId: String
    public let serviceId: String
    /// "allow" or "deny".
    public let decision: String
    /// "once", "session" or "service".
    public let duration: String
    public let capabilities: [String]
    public let origins: [String]
    public let localNetwork: LocalNetwork
    public let issuedAt: Int64

    public init(serverDomain: String, requestId: String, serviceId: String, decision: String, duration: String,
                capabilities: [String], origins: [String], localNetwork: LocalNetwork, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.requestId = requestId; self.serviceId = serviceId
        self.decision = decision; self.duration = duration; self.capabilities = capabilities
        self.origins = origins; self.localNetwork = localNetwork; self.issuedAt = issuedAt
    }

    private static func clean(_ s: String) -> Bool {
        !s.isEmpty && !s.unicodeScalars.contains(where: { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f })
    }

    public func canonicalBytes() throws -> Data {
        for (k, v) in [("serverDomain", serverDomain), ("requestId", requestId), ("serviceId", serviceId)] where !Self.clean(v) {
            throw Invalid(reason: k)
        }
        guard ["allow", "deny"].contains(decision) else { throw Invalid(reason: "decision") }
        guard ["once", "session", "service"].contains(duration) else { throw Invalid(reason: "duration") }
        guard issuedAt >= 0 else { throw Invalid(reason: "issuedAt") }
        for c in capabilities where !Self.clean(c) || c.contains(",") { throw Invalid(reason: "capability") }
        let originsDigest = SHA256.hash(data: Data(origins.sorted().joined(separator: "\n").utf8)).map { String(format: "%02x", $0) }.joined()
        let lan: String
        switch localNetwork {
        case .none: lan = "none"
        case .wholeLan: lan = "whole-lan"
        case .exact(let hosts): lan = "exact:" + hosts.sorted().joined(separator: ",")
        }
        let parts = [Self.canonicalTag, serverDomain.lowercased(), requestId, serviceId, decision, duration,
                     capabilities.sorted().joined(separator: ","), originsDigest, lan, String(issuedAt)]
        return Data(parts.joined(separator: "|").utf8)
    }
}

extension BrowserGrantAnswer {
    /// The scope part of an ask or of the owner's answer (`browserGrantWithin` in
    /// packages/protocol/src/browserGrant.ts).
    public struct Scope: Equatable, Sendable {
        public let duration: String
        public let capabilities: [String]
        public let origins: [String]
        public let localNetwork: LocalNetwork
        public init(duration: String, capabilities: [String], origins: [String], localNetwork: LocalNetwork) {
            self.duration = duration; self.capabilities = capabilities; self.origins = origins; self.localNetwork = localNetwork
        }
    }

    static let durations = ["once", "session", "service"]

    /// The durations the owner may choose for an ask, shortest first: the asked one or shorter.
    public static func durationChoices(asked: String) -> [String] {
        guard let rank = durations.firstIndex(of: asked) else { return [] }
        return Array(durations[0...rank])
    }

    /// The owner may grant the ask as it is or narrower, never wider (the box checks the same rule).
    public static func within(ask: Scope, answer: Scope) -> Bool {
        guard let a = durations.firstIndex(of: answer.duration), let q = durations.firstIndex(of: ask.duration), a <= q else { return false }
        let caps = Set(ask.capabilities)
        guard !answer.capabilities.isEmpty, answer.capabilities.allSatisfy({ caps.contains($0) }) else { return false }
        let origins = Set(ask.origins)
        guard answer.origins.allSatisfy({ origins.contains($0) }) else { return false }
        switch answer.localNetwork {
        case .none: break
        case .wholeLan:
            guard case .wholeLan = ask.localNetwork else { return false }
        case .exact(let hosts):
            guard case .exact(let asked) = ask.localNetwork, !hosts.isEmpty else { return false }
            let allowed = Set(asked)
            guard hosts.allSatisfy({ allowed.contains($0) }) else { return false }
        }
        if case .none = answer.localNetwork { return !answer.origins.isEmpty }
        return true
    }
}

/// `flagship/browser-grant-revoke/v1`: the owner withdraws a browser grant they gave an app; the box
/// drops it at once. Posted to `POST /api/browser/owner/grants/revoke`. Wire parity with
/// packages/protocol/src/browserGrant.ts; pinned by packages/protocol/test-vectors/browser-grant-revoke/vectors.json.
public struct BrowserGrantRevoke: Equatable, Sendable {
    public static let canonicalTag = "flagship/browser-grant-revoke/v1"

    public let serverDomain: String
    public let serviceId: String
    public let grantId: String
    public let issuedAt: Int64

    public init(serverDomain: String, serviceId: String, grantId: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.serviceId = serviceId; self.grantId = grantId; self.issuedAt = issuedAt
    }

    private static func clean(_ s: String) -> Bool {
        !s.isEmpty && !s.unicodeScalars.contains(where: { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f })
    }

    public func canonicalBytes() throws -> Data {
        for (k, v) in [("serverDomain", serverDomain), ("serviceId", serviceId), ("grantId", grantId)] where !Self.clean(v) {
            throw BrowserGrantAnswer.Invalid(reason: k)
        }
        guard issuedAt >= 0 else { throw BrowserGrantAnswer.Invalid(reason: "issuedAt") }
        return Data([Self.canonicalTag, serverDomain.lowercased(), serviceId, grantId, String(issuedAt)].joined(separator: "|").utf8)
    }
}
