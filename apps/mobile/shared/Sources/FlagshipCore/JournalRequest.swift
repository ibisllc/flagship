import Foundation
import CryptoKit

/// Owner-IRK-signed journal read (diagnostics) — Swift mirror of the standalone
/// `JournalRequest` envelope in `packages/protocol/src/auth.ts`. The daemon's
/// `/api/journal` re-derives these canonical bytes to verify the Ed25519
/// signature against its config-pinned owner IRK, then allowlists `unit` and
/// clamps `lines`. It is NOT a PhoneOrder (it mutates nothing), but the auth +
/// 5-minute replay window match `/api/power`.
///
/// The canonical bytes + `|`-joined field order MUST stay byte-identical to the
/// TS generator (pinned in `JournalCanonicalTests` and the webapp's
/// `webappJournal.test.ts`):
///
///   flagship/journal-read/v1|<serverId>|<unit>|<lines>|<issuedAt>
public struct JournalRequest: Equatable, Sendable {
    public static let canonicalTag = "flagship/journal-read/v1"

    public let serverId: String
    /// systemd unit to read; the daemon clamps this to an allowlist.
    public let unit: String
    /// trailing lines requested; the daemon clamps the max.
    public let lines: Int64
    public let issuedAt: Int64

    public init(serverId: String, unit: String, lines: Int64, issuedAt: Int64) {
        self.serverId = serverId
        self.unit = unit
        self.lines = lines
        self.issuedAt = issuedAt
    }

    /// `flagship/journal-read/v1|<serverId>|<unit>|<lines>|<issuedAt>`.
    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, serverId, unit, String(lines), String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }

    /// `{ request, signature }` body for `POST /api/journal`. The `request`
    /// shape matches `parseJournalRequest` in `server-daemon/src/journalHttp.ts`
    /// — no `type` field, unlike the power-off PhoneOrder (journal is standalone).
    public func envelope(signatureHex: String) -> [String: Any] {
        [
            "request": [
                "serverId": serverId,
                "unit": unit,
                "lines": lines,
                "issuedAt": issuedAt,
            ],
            "signature": signatureHex,
        ]
    }
}

/// Allowlisted units + defaults — mirror `journalHttp.ts`.
public enum JournalUnits {
    public static let all = ["flagship-daemon", "flagship-data-services"]
    public static let defaultUnit = "flagship-daemon"
    public static let defaultLines: Int64 = 200
    public static let maxLines: Int64 = 500
}
