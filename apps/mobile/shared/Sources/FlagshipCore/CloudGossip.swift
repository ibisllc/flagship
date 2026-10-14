import Foundation
import CryptoKit

/// The phone's part of the cloud gossip (`packages/protocol/src/cloudGossip.ts`):
/// the per-cloud CGK it delivers to each box. Boxes gossip and elect leaders;
/// the phone only ranks its servers (`ServerOrder`). Pinned in
/// `CloudGossipCanonicalTests.swift`.

public enum CloudGossip {

    // MARK: 1. CGK

    private static let infoCGK = "flagship.cloud-gossip.v1"

    /// `CGK = HKDF-SHA256(ikm = umkSeed, salt = empty,
    /// info = "flagship.cloud-gossip.v1", 32)` — per-cloud (no serverId).
    /// Mirrors `ServerKeys.deriveSwk`'s HKDF construction (empty salt).
    public static func deriveCGK(umkSeed: Data) -> Data? {
        guard umkSeed.count == 32 else { return nil }
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: umkSeed),
            salt: Data(),
            info: Data(infoCGK.utf8),
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }
}
