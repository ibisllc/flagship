import Foundation
import CryptoKit

/// Mirrors @flagship/protocol's auth canonicalization. Keep in sync with
/// `packages/protocol/src/auth.ts`.
public struct BootChallenge: Codable {
    public let serverId: String
    public let nonce: Data
    public let issuedAt: Int64
}

public struct BootAuthorization {
    public static func sign(challenge: BootChallenge, with bak: Curve25519.Signing.PrivateKey) throws -> Data {
        let canonical = canonicalBytes(challenge)
        return try bak.signature(for: canonical)
    }

    private static func canonicalBytes(_ c: BootChallenge) -> Data {
        let s = "flagship/boot/v1|\(c.serverId)|\(c.nonce.hexString)|\(c.issuedAt)"
        return Data(s.utf8)
    }
}

extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
