import Foundation
import CryptoKit

/// Owner-assignable apex ("front page") — Swift mirror of the
/// `set-front-page` PhoneOrder in `packages/protocol/src/auth.ts`. The box's
/// root domain 302s to the named installed service's tier-1 canonical
/// (`https://<label>.<serverId>/`), or serves the default Flagship page when
/// `label` is "" (clear).
///
/// Canonical bytes MUST stay byte-identical to the TS generator (pinned by
/// the cross-platform vector in `packages/protocol/tests/setFrontPage.test.ts`
/// and mirrored in `FrontPageCanonicalTests`):
///
///   flagship/order/set-front-page/v1|<serverId>|<label>|<issuedAt>
public struct SetFrontPageOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/order/set-front-page/v1"

    public let serverId: String
    /// Service url-label to front-page; "" clears (default page).
    public let label: String
    public let issuedAt: Int64

    public init(serverId: String, label: String, issuedAt: Int64) {
        self.serverId = serverId
        self.label = label
        self.issuedAt = issuedAt
    }

    /// `flagship/order/set-front-page/v1|<serverId>|<label>|<issuedAt>`.
    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, serverId, label, String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }

    /// The `{ request, signature }` JSON the daemon's `/api/front-page`
    /// expects (the `request` shape matches `parseSetFrontPage` in
    /// `server-daemon/src/frontPage.ts`).
    public func envelope(signatureHex: String) -> [String: Any] {
        [
            "request": [
                "type": "set-front-page",
                "serverId": serverId,
                "label": label,
                "issuedAt": issuedAt,
            ],
            "signature": signatureHex,
        ]
    }
}
