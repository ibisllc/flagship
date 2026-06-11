import Foundation
import CryptoKit

/// Lock & power-off + dead-man heartbeat-lock — Swift mirror of the three
/// signed envelopes added to `packages/protocol/src/auth.ts`:
///
///   - `power-off` PhoneOrder  (PSK/IRK-signed — same key the daemon's
///     orders endpoint pins; on this account that is the owner IRK, exactly
///     as the webapp's `add-paired-session` order is IRK-signed)
///   - `SetDeadManPolicy`      (owner-IRK-signed)
///   - `DeadManAffirmation`    (owner-IRK-signed)
///
/// The canonical bytes + `|`-joined field order MUST stay byte-identical to
/// the TS generators (pinned by the cross-platform vectors in
/// `packages/protocol/tests/lockAndPowerOff.test.ts` and mirrored in
/// `LockAndPowerOffCanonicalTests`):
///
///   flagship/order/power-off/v1|<serverId>|<mode>|<issuedAt>
///   flagship/set-deadman-policy/v1|<serverId>|<enabled 0|1>|<windowMs>|<graceMs>|<lockoutMode>|<issuedAt>
///   flagship/deadman-affirm/v1|<serverId>|<nonceHex>|<issuedAt>
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

/// Owner-IRK-signed dead-man policy. Mirrors the TS `SetDeadManPolicy`.
public struct DeadManPolicy: Equatable, Sendable {
    public static let canonicalTag = "flagship/set-deadman-policy/v1"

    public let serverId: String
    public let enabled: Bool
    /// Affirmation window in ms — each affirmation sets expiry = now + windowMs.
    public let windowMs: Int64
    /// Extra grace past the window before the lockout fires.
    public let graceMs: Int64
    /// Host action on lapse: poweroff (`off`, default) or reboot (`restart`).
    public let lockoutMode: PowerMode
    public let issuedAt: Int64

    public init(
        serverId: String,
        enabled: Bool,
        windowMs: Int64,
        graceMs: Int64,
        lockoutMode: PowerMode,
        issuedAt: Int64
    ) {
        self.serverId = serverId
        self.enabled = enabled
        self.windowMs = windowMs
        self.graceMs = graceMs
        self.lockoutMode = lockoutMode
        self.issuedAt = issuedAt
    }

    /// `flagship/set-deadman-policy/v1|<serverId>|<enabled 0|1>|<windowMs>|<graceMs>|<lockoutMode>|<issuedAt>`.
    public func canonicalBytes() -> Data {
        Data(
            [
                Self.canonicalTag,
                serverId,
                enabled ? "1" : "0",
                String(windowMs),
                String(graceMs),
                lockoutMode.rawValue,
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    /// `{ request, signature }` body for `POST /api/deadman/policy`. The
    /// `request` shape matches `parsePolicy` in `server-daemon/src/deadManHttp.ts`.
    public func envelope(signatureHex: String) -> [String: Any] {
        [
            "request": [
                "serverId": serverId,
                "enabled": enabled,
                "windowMs": windowMs,
                "graceMs": graceMs,
                "lockoutMode": lockoutMode.rawValue,
                "issuedAt": issuedAt,
            ],
            "signature": signatureHex,
        ]
    }
}

/// Owner-IRK-signed keep-unlocked affirmation. Mirrors the TS
/// `DeadManAffirmation`. `nonce` is fresh (16+ bytes) per affirmation; the
/// daemon rejects a replayed value. The wire body carries the nonce as
/// lowercased hex (see `parseAffirm`).
public struct DeadManAffirmation: Equatable, Sendable {
    public static let canonicalTag = "flagship/deadman-affirm/v1"

    public let serverId: String
    public let nonce: Data
    public let issuedAt: Int64

    public init(serverId: String, nonce: Data, issuedAt: Int64) {
        self.serverId = serverId
        self.nonce = nonce
        self.issuedAt = issuedAt
    }

    public var nonceHex: String { HexUtil.encode(nonce) }

    /// `flagship/deadman-affirm/v1|<serverId>|<nonceHex>|<issuedAt>`.
    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, serverId, nonceHex, String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    /// `{ request, signature }` body for `POST /api/deadman/affirm`.
    public func envelope(signatureHex: String) -> [String: Any] {
        [
            "request": [
                "serverId": serverId,
                "nonce": nonceHex,
                "issuedAt": issuedAt,
            ],
            "signature": signatureHex,
        ]
    }

    /// Fresh 16-byte nonce. The daemon requires 16+ bytes.
    public static func freshNonce() -> Data {
        var b = Data(count: 16)
        _ = b.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        return b
    }
}
