import Foundation
import CryptoKit

/// Owner-IRK-signed service uninstall — Swift mirror of `UninstallServiceRequest`
/// in `packages/protocol/src/serviceLifecycle.ts`. The daemon's
/// `DELETE /api/services/:id` re-derives these canonical bytes to verify the
/// Ed25519 signature against the host's owner IRK (the SAME trust root as
/// install / set-service-env), then removes the container, drops the data
/// namespace, and forgets the membership store. Idempotent against an
/// already-uninstalled service.
///
/// It is NOT a PhoneOrder (no `type` field) — the standalone `{ request,
/// signature }` shape matches `uninstallService` in
/// `server-daemon/src/servicePlatform.ts`.
///
/// The canonical bytes + `|`-joined field order MUST stay byte-identical to the
/// TS generator (`canonicalUninstallService`), pinned in
/// `ServiceUninstallTests`:
///
///   flagship/uninstall-service/v1|<serverId>|<creator>|<slug>|<issuedAt>
public struct UninstallServiceOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/uninstall-service/v1"

    /// The host box's id (`<server>.<user>.flagship.services`) the daemon
    /// pins as `serverId` — its config-bound owner IRK is the verifier.
    public let serverId: String
    public let creator: String
    public let slug: String
    public let issuedAt: Int64

    public init(serverId: String, creator: String, slug: String, issuedAt: Int64) {
        self.serverId = serverId
        self.creator = creator
        self.slug = slug
        self.issuedAt = issuedAt
    }

    /// `flagship/uninstall-service/v1|<serverId>|<creator>|<slug>|<issuedAt>`.
    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, serverId, creator, slug, String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }

    /// The `{ request, signature }` body `DELETE /api/services/:id` expects.
    /// The `request` shape matches the daemon's field check in
    /// `uninstallService` (serverId / creator / slug / issuedAt, no `type`).
    public func envelope(signatureHex: String) -> [String: Any] {
        [
            "request": [
                "serverId": serverId,
                "creator": creator,
                "slug": slug,
                "issuedAt": issuedAt,
            ],
            "signature": signatureHex,
        ]
    }
}
