import Foundation

/// `flagship/server-wildcard-grant/v1`: the admin's once-per-server permission for a box to hold a
/// certificate for every app name on the account (`*.<user>.<apex>`). Signed with the sensitive-order
/// key and sent to the box at `POST /api/screens/server-wildcard-grant`. Wire parity with
/// packages/protocol/src/serverWildcardGrant.ts; pinned by
/// packages/protocol/test-vectors/server-wildcard-grant/vectors.json.
///
///   flagship/server-wildcard-grant/v1|<username lowercase>|<serverDomain lowercase>|<stkPubHex>|<issuedAt>
public struct ServerWildcardGrant: Equatable, Sendable {
    public static let canonicalTag = "flagship/server-wildcard-grant/v1"
    public struct Invalid: Error, Equatable { public let reason: String }

    public let username: String
    public let serverDomain: String
    /// The server's registered identity key, 64 lowercase hex.
    public let stkPubHex: String
    public let issuedAt: Int64

    public init(username: String, serverDomain: String, stkPubHex: String, issuedAt: Int64) {
        self.username = username
        self.serverDomain = serverDomain
        self.stkPubHex = stkPubHex
        self.issuedAt = issuedAt
    }

    private static func clean(_ s: String) -> Bool {
        !s.isEmpty && !s.unicodeScalars.contains(where: { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f })
    }

    public func canonicalBytes() throws -> Data {
        guard Self.clean(username) else { throw Invalid(reason: "username") }
        guard Self.clean(serverDomain) else { throw Invalid(reason: "serverDomain") }
        guard stkPubHex.count == 64, stkPubHex.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw Invalid(reason: "stkPubHex") }
        let user = username.lowercased()
        let domain = serverDomain.lowercased()
        guard domain.contains(".\(user).") else { throw Invalid(reason: "the server is not on this account") }
        guard issuedAt >= 0 else { throw Invalid(reason: "issuedAt") }
        return Data([Self.canonicalTag, user, domain, stkPubHex, String(issuedAt)].joined(separator: "|").utf8)
    }

    /// The JSON body of `POST /api/screens/server-wildcard-grant`.
    public func body(signature: Data) -> [String: Any] {
        ["issuedAt": issuedAt, "signature": signature.map { String(format: "%02x", $0) }.joined()]
    }
}
