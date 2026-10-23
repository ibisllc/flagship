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
