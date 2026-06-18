import Foundation
import CryptoKit

/// IRK-signed `install-service` request — Swift mirror of
/// `packages/protocol/src/serviceLifecycle.ts` (`canonicalInstallService` /
/// `signInstallService`). The owner installs an app on their own box; the
/// daemon's `POST /api/services` re-derives these canonical bytes to verify the
/// Ed25519 signature against its config-pinned owner IRK (the SAME trust root
/// as `/api/power` / `/api/journal`), then builds + runs the container.
///
/// Canonical bytes (byte-identical to the TS generator; `manifestJson` is NOT
/// `|`-guarded because it is a JSON blob whose integrity is bound by being part
/// of the signed bytes, and canonical bytes are only ever compared whole):
///
///   flagship/install-service/v1|<serverId>|<creator>|<slug>|<manifestJson>|<addOwnerToMembership 0|1>|<issuedAt>
public struct InstallServiceOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/install-service/v1"

    public let serverId: String
    public let creator: String
    public let slug: String
    /// Stringified `flagship.app.json` — the manifest as the phone reviewed it.
    public let manifestJson: String
    public let addOwnerToMembership: Bool
    public let issuedAt: Int64

    public init(
        serverId: String,
        creator: String,
        slug: String,
        manifestJson: String,
        addOwnerToMembership: Bool,
        issuedAt: Int64
    ) {
        self.serverId = serverId
        self.creator = creator
        self.slug = slug
        self.manifestJson = manifestJson
        self.addOwnerToMembership = addOwnerToMembership
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data(
            [
                Self.canonicalTag,
                serverId,
                creator,
                slug,
                manifestJson,
                addOwnerToMembership ? "1" : "0",
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    /// `{ request, signature }` body for `POST /api/services`. The `request`
    /// shape matches `installService` in `server-daemon/src/servicePlatform.ts`.
    public func envelope(signatureHex: String) -> [String: Any] {
        [
            "request": [
                "serverId": serverId,
                "creator": creator,
                "slug": slug,
                "manifestJson": manifestJson,
                "addOwnerToMembership": addOwnerToMembership,
                "issuedAt": issuedAt,
            ],
            "signature": signatureHex,
        ]
    }
}
