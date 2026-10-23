import Foundation
import CryptoKit

/// One line of the security sliver (SECURITY-HARDENING-PLAN.md 18.14): its own severity, target, state,
/// deadline and action, never merged with another. The box decides the severity; the app never does.
public struct SliverLine: Codable, Equatable, Sendable, Identifiable {
    public let eventId: String
    public let issueKey: String
    public let kind: String
    public let severity: String
    public let target: String
    public let state: String
    public let summary: String
    public let updatedAt: Int64
    public let remainingMs: Int64?
    public let action: String?
    public var id: String { eventId }
    public var isActive: Bool { state == "active" }
    public init(eventId: String, issueKey: String, kind: String, severity: String, target: String, state: String, summary: String, updatedAt: Int64, remainingMs: Int64?, action: String?) {
        self.eventId = eventId; self.issueKey = issueKey; self.kind = kind; self.severity = severity; self.target = target
        self.state = state; self.summary = summary; self.updatedAt = updatedAt; self.remainingMs = remainingMs; self.action = action
    }
}

public struct SecuritySliverResponse: Codable, Equatable, Sendable {
    public let lines: [SliverLine]
    public let lostHistory: Bool
    public init(lines: [SliverLine], lostHistory: Bool = false) { self.lines = lines; self.lostHistory = lostHistory }
}

/// What the owner's device signs to trust a new publisher key for ONE service
/// (`flagship/publisher-trust/v1`, vectors `test-vectors/publisher-trust`).
public struct PublisherTrust: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/publisher-trust/v1"
    public var serviceId: String
    public var appId: String
    public var identityGeneration: Int
    public var oldKeyHex: String
    public var newKeyHex: String
    public var newEpoch: Int
    public var issuedAt: Int64

    public init(serviceId: String, appId: String, identityGeneration: Int, oldKeyHex: String, newKeyHex: String, newEpoch: Int, issuedAt: Int64) {
        self.serviceId = serviceId; self.appId = appId; self.identityGeneration = identityGeneration
        self.oldKeyHex = oldKeyHex; self.newKeyHex = newKeyHex; self.newEpoch = newEpoch; self.issuedAt = issuedAt
    }

    public enum TrustError: Error, Equatable { case badField(String) }

    public func canonicalBytes() throws -> Data {
        for (n, v) in [("serviceId", serviceId), ("appId", appId)] {
            if v.isEmpty { throw TrustError.badField(n) }
            for u in v.unicodeScalars where u.value == 0x7c || u.value <= 0x1f || u.value == 0x7f { throw TrustError.badField(n) }
        }
        return Data([Self.canonicalTag, serviceId, appId, String(identityGeneration), oldKeyHex, newKeyHex, String(newEpoch), String(issuedAt)].joined(separator: "|").utf8)
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> String {
        try key.signature(for: canonicalBytes()).map { String(format: "%02x", $0) }.joined()
    }
}

/// `GET /api/screens/services/:id/publisher`: the pinned key and a key waiting for the owner.
public struct WaitingPublisherResponse: Codable, Equatable, Sendable {
    public struct Pinned: Codable, Equatable, Sendable { public let fingerprint: String; public let epoch: Int }
    public struct Waiting: Codable, Equatable, Sendable {
        public let continuity: String
        public let oldFingerprint: String
        public let newFingerprint: String
        public let newEpoch: Int
        public let rejected: Bool
        public let trust: PublisherTrust?
        public init(continuity: String, oldFingerprint: String, newFingerprint: String, newEpoch: Int, rejected: Bool, trust: PublisherTrust?) {
            self.continuity = continuity; self.oldFingerprint = oldFingerprint; self.newFingerprint = newFingerprint
            self.newEpoch = newEpoch; self.rejected = rejected; self.trust = trust
        }
    }
    public let pinned: Pinned?
    public let waiting: Waiting?
    public init(pinned: Pinned?, waiting: Waiting?) { self.pinned = pinned; self.waiting = waiting }
}

public enum SliverWords {
    public static let heading = "Security"
    public static let trust = "Trust this new key for this service"
    public static let reject = "Reject and pause updates"
    public static let chain = "The old key vouched for the new one."
    public static let noChain = "The old key did not vouch for the new one. Treat this as a different publisher using the same name."
    public static let warning = "If this is unusual, do not trust the new key. Updates from this publisher stay paused until you decide."
    public static let lostHistory = "This server lost its list of security notices and started over. Check each service and your recovery settings."

    public static func severityLabel(_ s: String) -> String {
        switch s { case "critical": return "Critical"; case "high": return "High"; case "moderate": return "Moderate"; case "low": return "Low"; default: return s }
    }

    /// "2 days 3 hours left", "overdue by 2 hours 0 minutes", or "" with no deadline.
    public static func remaining(_ ms: Int64?) -> String {
        guard let ms else { return "" }
        let a = abs(ms), day: Int64 = 86_400_000, hour: Int64 = 3_600_000, min: Int64 = 60_000
        let body: String
        if a >= day { body = "\(a / day) day\(a / day == 1 ? "" : "s") \((a % day) / hour) hours" }
        else if a >= hour { body = "\(a / hour) hour\(a / hour == 1 ? "" : "s") \((a % hour) / min) minutes" }
        else { let m = Swift.max(1, a / min); body = "\(m) minute\(m == 1 ? "" : "s")" }
        return ms >= 0 ? "\(body) left" : "overdue by \(body)"
    }
}
