import Foundation

/// `flagship/chat-approval/v1`: the owner's answer to a held app-chat request, signed with the sensitive-order
/// key and carried by the paired session to `POST /api/screens/chat/answer`. Wire parity with
/// packages/protocol/src/chatWire.ts; pinned by packages/protocol/test-vectors/chat-approval/vectors.json.
///
///   flagship/chat-approval/v1|<serverDomain lowercase>|<requestId>|<kind>|<decision>|<issuedAt>
public struct ChatApproval: Equatable, Sendable {
    public static let canonicalTag = "flagship/chat-approval/v1"

    public enum Kind: String, Sendable { case incoming, outgoing }
    public enum Decision: String, Sendable { case allow, always, deny }
    public struct Invalid: Error, Equatable { public let reason: String }

    public let serverDomain: String
    public let requestId: String
    public let kind: Kind
    public let decision: Decision
    public let issuedAt: Int64

    public init(serverDomain: String, requestId: String, kind: Kind, decision: Decision, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.requestId = requestId
        self.kind = kind
        self.decision = decision
        self.issuedAt = issuedAt
    }

    private static func clean(_ s: String) -> Bool {
        !s.isEmpty && !s.unicodeScalars.contains(where: { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f })
    }

    public func canonicalBytes() throws -> Data {
        guard Self.clean(serverDomain) else { throw Invalid(reason: "serverDomain") }
        guard Self.clean(requestId) else { throw Invalid(reason: "requestId") }
        if decision == .always && kind != .incoming { throw Invalid(reason: "always allow applies to incoming requests only") }
        guard issuedAt >= 0 else { throw Invalid(reason: "issuedAt") }
        let parts = [Self.canonicalTag, serverDomain.lowercased(), requestId, kind.rawValue, decision.rawValue, String(issuedAt)]
        return Data(parts.joined(separator: "|").utf8)
    }

    /// The JSON body of `POST /api/screens/chat/answer`.
    public func body(signature: Data) -> [String: Any] {
        [
            "requestId": requestId,
            "kind": kind.rawValue,
            "decision": decision.rawValue,
            "issuedAt": issuedAt,
            "signature": signature.map { String(format: "%02x", $0) }.joined(),
        ]
    }
}
