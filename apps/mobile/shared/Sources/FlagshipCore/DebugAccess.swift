import Foundation
import CryptoKit

/// Owner-authorized debug-access grant (Swift mirror of
/// packages/protocol/src/debugAccess.ts). The phone signs this behind the
/// create biometric when the user turns on "Debug-friendly server" (Advanced
/// mode) and bakes it into the recipe as the UNSIGNED `debugGrant` sibling; the
/// box verifies it against the owner IRK before enabling the debug console
/// user / SSH.
///
/// Canonical bytes (byte-identical to TS + Kotlin, pinned vector):
///   flagship/debug-access/v1|<serverDomain>|<sshAuthorizedKey>|<issuedAt>
public enum DebugAccess {
    public struct Grant: Codable, Equatable, Sendable {
        public let serverDomain: String
        public let sshAuthorizedKey: String
        public let issuedAt: Int64
        public init(serverDomain: String, sshAuthorizedKey: String, issuedAt: Int64) {
            self.serverDomain = serverDomain
            self.sshAuthorizedKey = sshAuthorizedKey
            self.issuedAt = issuedAt
        }
    }

    public static func canonicalBytes(_ g: Grant) -> Data {
        Data("flagship/debug-access/v1|\(g.serverDomain)|\(g.sshAuthorizedKey)|\(g.issuedAt)".utf8)
    }

    /// Sign with the owner IRK; returns the signature hex.
    public static func sign(_ g: Grant, irk: Curve25519.Signing.PrivateKey) throws -> String {
        let sig = try irk.signature(for: canonicalBytes(g))
        return sig.map { String(format: "%02x", $0) }.joined()
    }

    public static func verify(_ g: Grant, signatureHex: String, irkPub: Data) -> Bool {
        guard let sig = dataFromHex(signatureHex),
              let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: irkPub) else { return false }
        return pub.isValidSignature(sig, for: canonicalBytes(g))
    }

    /// The recipe's `debugGrant` sibling: `{grant:{...}, signatureHex}` (JSON).
    /// Baked into the recipe at mint time and consumed verbatim by the box-side
    /// gate (`debugAccessGate.ts`).
    public static func envelopeJSON(_ g: Grant, signatureHex: String) -> String {
        let body: [String: Any] = [
            "grant": ["serverDomain": g.serverDomain,
                      "sshAuthorizedKey": g.sshAuthorizedKey,
                      "issuedAt": g.issuedAt],
            "signatureHex": signatureHex,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }

    private static func dataFromHex(_ s: String) -> Data? {
        guard s.count % 2 == 0 else { return nil }
        var out = Data(capacity: s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let n = s.index(i, offsetBy: 2)
            guard let b = UInt8(s[i..<n], radix: 16) else { return nil }
            out.append(b); i = n
        }
        return out
    }
}
