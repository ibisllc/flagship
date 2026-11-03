import Foundation
import CryptoKit

/// Owner-IRK-signed journal read (diagnostics) — Swift mirror of the standalone
/// `JournalRequest` envelope in `packages/protocol/src/auth.ts`. The daemon's
/// `/api/journal` re-derives these canonical bytes to verify the Ed25519
/// signature against its config-pinned owner IRK, then allowlists `unit` and
/// clamps `lines`. It is NOT a PhoneOrder (it mutates nothing). The box takes a
/// request inside a 5-minute window and once per nonce (review 2026-10-25 #15).
///
/// The canonical bytes + `|`-joined field order MUST stay byte-identical to the
/// TS generator (pinned in `JournalCanonicalTests` and the webapp's
/// `webappJournal.test.ts`):
///
///   flagship/journal-read/v2|<serverId>|<unit>|<lines>|<nonce>|<issuedAt>
public struct JournalRequest: Equatable, Sendable {
    public static let canonicalTag = "flagship/journal-read/v2"

    public enum Failure: Error, Equatable { case badNonce }

    public let serverId: String
    /// systemd unit to read; the daemon clamps this to an allowlist.
    public let unit: String
    /// trailing lines requested; the daemon clamps the max.
    public let lines: Int64
    /// Single use: 16 random bytes as 32 lowercase hex; the box refuses one it already took.
    public let nonce: String
    public let issuedAt: Int64

    public init(serverId: String, unit: String, lines: Int64, nonce: String = JournalRequest.newNonce(), issuedAt: Int64) {
        self.serverId = serverId
        self.unit = unit
        self.lines = lines
        self.nonce = nonce
        self.issuedAt = issuedAt
    }

    /// 16 bytes from the system's secure generator, as 32 lowercase hex.
    public static func newNonce() -> String {
        var g = SystemRandomNumberGenerator()
        return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &g)) }.joined()
    }

    static func validNonce(_ n: String) -> Bool {
        n.utf8.count == 32 && n.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// `flagship/journal-read/v2|<serverId>|<unit>|<lines>|<nonce>|<issuedAt>`.
    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, serverId, unit, String(lines), nonce, String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> Data {
        guard Self.validNonce(nonce) else { throw Failure.badNonce }
        return try key.signature(for: canonicalBytes())
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
                "nonce": nonce,
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
