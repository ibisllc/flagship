import Foundation
import CryptoKit

/// Lock & power-off — Swift mirror of the `power-off` PhoneOrder in
/// `packages/protocol/src/auth.ts` (PSK/IRK-signed — same key the daemon's
/// orders endpoint pins). The canonical bytes MUST stay byte-identical to the
/// TS generator (pinned by `packages/protocol/tests/lockAndPowerOff.test.ts`
/// and mirrored in `LockAndPowerOffCanonicalTests`):
///
///   flagship/order/power-off/v1|<serverId>|<mode>|<issuedAt>
///
/// The old dead-man switch (`set-deadman-policy/v1`, `deadman-affirm/v1`) is
/// retired: it is the serving policy's `lock-server` now (ServingAuthority.swift).
public enum PowerMode: String, Sendable, Equatable, CaseIterable {
    /// `systemctl poweroff` — the box stays off until power-cycled. On a
    /// LUKS-from-phone box this drops the in-memory disk key ("lock").
    case off
    /// `systemctl reboot` — fast resume; on a LUKS box the next boot lands at
    /// the phone-approval unlock prompt.
    case restart
}

/// A signed `power-off` PhoneOrder. Mirrors the TS `PhoneOrder` variant
/// `{ type:"power-off", serverId, mode, issuedAt }` and its canonical bytes.
public struct PowerOffOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/order/power-off/v1"

    public let serverId: String
    public let mode: PowerMode
    public let issuedAt: Int64

    public init(serverId: String, mode: PowerMode, issuedAt: Int64) {
        self.serverId = serverId
        self.mode = mode
        self.issuedAt = issuedAt
    }

    /// `flagship/order/power-off/v1|<serverId>|<mode>|<issuedAt>`.
    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, serverId, mode.rawValue, String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }

    /// The `{ request, signature }` JSON the daemon's `/api/power`
    /// expects (the `request` shape matches `parseOrder` in
    /// `server-daemon/src/orders.ts`).
    public func envelope(signatureHex: String) -> [String: Any] {
        [
            "request": [
                "type": "power-off",
                "serverId": serverId,
                "mode": mode.rawValue,
                "issuedAt": issuedAt,
            ],
            "signature": signatureHex,
        ]
    }
}
