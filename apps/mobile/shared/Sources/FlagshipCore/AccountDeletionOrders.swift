import Foundation
import CryptoKit

/// Account-deletion / username-reclaim orders — the Swift mirror of the
/// `account-self-delete` + `servers-self-delete` envelopes in
/// `packages/protocol/src/legacyEnvelopes.ts`.
///
/// Both are OWNER-IRK-signed and issued ONLY inside the last-device deletion
/// ceremony (typed-username + biometric). `.com` verifies them against the
/// username's registered IRK.
///
/// - `account-self-delete` is the last-device account-death order: `.com`
///   enforces "no other active device", then HARD-DELETES the username row
///   (the name frees immediately) + tears down every server the account owns.
/// - `servers-self-delete` is the opt-in "ask all my servers to delete their
///   content" order. It is NEVER a standalone command — `.com` accepts it ONLY
///   when atomically bundled with a valid account-self-delete (the bundle-ingest
///   invariant; docs/account-deletion-and-name-reclaim.md §5).
///
/// The canonical bytes + `|`-joined field order MUST stay byte-identical to the
/// TS generators and the Kotlin mirror:
///
///   flagship/account-self-delete/v1|<username>|<issuedAt>
///   flagship/servers-self-delete/v1|<username>|<issuedAt>
///
/// `username` is lowercased into the canonical bytes (matching the TS
/// `.toLowerCase()`), so the signing UI need not normalize first.
public struct AccountSelfDeleteOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/account-self-delete/v1"

    public let username: String
    public let issuedAt: Int64

    public init(username: String, issuedAt: Int64) {
        self.username = username
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, username.lowercased(), String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    /// The `{ request, signature }` JSON `.com` expects on the deletion-bundle
    /// endpoint (the `request` shape mirrors the TS handler body).
    public func request() -> [String: Any] {
        ["username": username.lowercased(), "issuedAt": issuedAt]
    }
}

public struct ServersSelfDeleteOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/servers-self-delete/v1"

    public let username: String
    public let issuedAt: Int64

    public init(username: String, issuedAt: Int64) {
        self.username = username
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, username.lowercased(), String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    public func request() -> [String: Any] {
        ["username": username.lowercased(), "issuedAt": issuedAt]
    }
}
