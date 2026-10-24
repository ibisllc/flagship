import Foundation
import CryptoKit

/// Test fixtures only: a deterministic Ed25519 key per (seed, server) so tests have stable box keys.
/// App code never derives a server key (docs/first-contact.md); it pins the key the box made.
enum TestServerKeys {
    static func deriveStkSeed(umkSeed: Data, serverId: String) -> Data? {
        guard umkSeed.count == 32 else { return nil }
        let swk = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: umkSeed), salt: Data(),
                                         info: Data("flagship.swk.v1|\(serverId)".utf8), outputByteCount: 32)
        let seed = HKDF<SHA256>.deriveKey(inputKeyMaterial: swk, salt: Data(),
                                          info: Data("flagship.stk.v1".utf8), outputByteCount: 32)
        return seed.withUnsafeBytes { Data($0) }
    }

    static func deriveStkPub(umkSeed: Data, serverId: String) -> Data? {
        guard let seed = deriveStkSeed(umkSeed: umkSeed, serverId: serverId),
              let priv = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else { return nil }
        return priv.publicKey.rawRepresentation
    }
}
