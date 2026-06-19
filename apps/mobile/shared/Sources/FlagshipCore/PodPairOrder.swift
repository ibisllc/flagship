import Foundation
import CryptoKit

/// Pod ↔ device pairing — the Swift mirror of the webapp's
/// `apps/web/public/webapp/lib/podPair.js` and the `add-paired-session`
/// `PhoneOrder` variant in `packages/protocol/src/orders.ts`.
///
/// The box's `/api/screens/*` BFF (the entire server-detail / services /
/// vibe surface) is gated on a paired-session token carried in the
/// `x-flagship-session` header. The phone mints that token by signing an
/// `add-paired-session` order with the OWNER IRK and POSTing it to the box's
/// `/api/orders-from-user` — the same root authority `/api/power`,
/// `/api/journal`, and `/api/front-page` already verify against (on a real
/// box the daemon's orders endpoint falls back to the config-pinned owner IRK
/// because the per-server PSK private half is discarded at create-time and the
/// `psk.pub.hex` file is never written).
///
/// The canonical bytes + `|`-joined field order MUST stay byte-identical to
/// the TS generator (`canonicalPhoneOrder` in `orders.ts`) and the webapp
/// (`canonicalAddPairedSession` in `podPair.js`):
///
///   flagship/order/add-paired-session/v1|<serverId>|<token>|<label>|<issuedAt>
///
/// `serverId` is the pod's FQDN (the daemon enforces `serverId` === its own
/// FQDN); `token` is fresh 32-byte hex; `label` is a human-readable name the
/// owner can later revoke ("Harry's iPhone").
public struct AddPairedSessionOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/order/add-paired-session/v1"

    public let serverId: String
    public let token: String
    public let label: String
    public let issuedAt: Int64

    public init(serverId: String, token: String, label: String, issuedAt: Int64) {
        self.serverId = serverId
        self.token = token
        self.label = label
        self.issuedAt = issuedAt
    }

    /// `flagship/order/add-paired-session/v1|<serverId>|<token>|<label>|<issuedAt>`.
    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, serverId, token, label, String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    /// The `{ request, signature }` JSON the daemon's `/api/orders-from-user`
    /// expects — the `request` shape matches `parseOrder` in
    /// `server-daemon/src/orders.ts` (`type:"add-paired-session"`).
    public func envelope(signatureHex: String) -> [String: Any] {
        [
            "request": [
                "type": "add-paired-session",
                "serverId": serverId,
                "token": token,
                "label": label,
                "issuedAt": issuedAt,
            ],
            "signature": signatureHex,
        ]
    }

    /// Fresh 32-byte session token, lowercased hex — the same width the webapp
    /// generates (`randomTokenHex`) and the daemon stores verbatim.
    public static func freshToken() -> String {
        var b = Data(count: 32)
        _ = b.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        return HexUtil.encode(b)
    }
}
