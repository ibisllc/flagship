import Foundation

/// `flagship/companion-delegation/v1`: an admin device's grant to ONE Remote (browser) session to build
/// and/or deploy ONE app for a short time (SECURITY-HARDENING-PLAN.md 16.2, SEC-AUTH-002). Wire parity
/// with packages/protocol/src/companionDelegation.ts; must pass
/// packages/protocol/test-vectors/companion-delegation/vectors.json.
///
///   flagship/companion-delegation/v1|<sessionId>|<serviceRef>|<ops sorted, comma-separated>|<issuedAt>|<expiresAt>
public struct CompanionDelegationInvalid: Error, Equatable {
    public let reason: String
}

public struct CompanionDelegationOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/companion-delegation/v1"
    public static let allowedOps: Set<String> = ["build", "deploy"]
    /// A delegation lasts at most a day, whatever is signed.
    public static let maxMs: Int64 = 24 * 3_600_000

    public let sessionId: String
    public let serviceRef: String
    public let ops: [String]
    public let issuedAt: Int64
    public let expiresAt: Int64

    public init(sessionId: String, serviceRef: String, ops: [String], issuedAt: Int64, expiresAt: Int64) {
        self.sessionId = sessionId
        self.serviceRef = serviceRef
        self.ops = ops
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    public func canonicalBytes() throws -> Data {
        guard AppAccessOrderCheck.lowerHex(sessionId, count: 16) else { throw CompanionDelegationInvalid(reason: "sessionId") }
        do { try AppAccessOrderCheck.serviceRef(serviceRef) } catch { throw CompanionDelegationInvalid(reason: "serviceRef") }
        guard !ops.isEmpty, ops.allSatisfy({ Self.allowedOps.contains($0) }) else { throw CompanionDelegationInvalid(reason: "ops") }
        guard issuedAt >= 0 else { throw CompanionDelegationInvalid(reason: "issuedAt") }
        guard expiresAt > issuedAt else { throw CompanionDelegationInvalid(reason: "expiresAt") }
        let sorted = Array(Set(ops)).sorted().joined(separator: ",")
        return AppAccessOrderCheck.join([Self.canonicalTag, sessionId, serviceRef, sorted, String(issuedAt), String(expiresAt)])
    }

    public var request: [String: Any] {
        ["sessionId": sessionId, "serviceRef": serviceRef, "ops": Array(Set(ops)).sorted(), "issuedAt": issuedAt, "expiresAt": expiresAt]
    }
}
