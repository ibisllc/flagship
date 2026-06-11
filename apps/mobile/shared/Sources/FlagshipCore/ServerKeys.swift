import Foundation
import CryptoKit

/// Swift mirror of the phone-side server-key derivation in
/// `packages/protocol/src/keys.ts` (`deriveSWK` / `deriveSTK`). The phone
/// holds the UMK, so it can derive any of its boxes' STK pubkeys LOCALLY —
/// this is what makes the STK-signed daemon-status report verifiable
/// end-to-end without trusting `.com`'s `identityPubKey` echo (cert-model
/// A′, phase 4 pinning).
///
/// MUST stay byte-identical to the TS implementation:
///   SWK      = HKDF-SHA256(ikm = UMK seed, salt = empty,
///                          info = "flagship.swk.v1|<serverId>", 32)
///   STK seed = HKDF-SHA256(ikm = SWK, salt = empty,
///                          info = "flagship.stk.v1", 32)
///   STK      = Ed25519 keypair from that seed
/// The pinned cross-platform vector in DaemonStatusVerifierTests (UMK 07×32
/// → STK pub 0a1eaaad…0d47) locks this in. NOTE: these are the PROTOCOL
/// info strings (dot-separated, from keys.ts) — distinct from the iOS
/// Keystore's app-backup SWK ("flagship/swk/v1|…"), which never has to
/// match the box.
public enum ServerKeys {
    private static let infoSWK = "flagship.swk.v1"
    private static let infoSTK = "flagship.stk.v1"

    public static func deriveSwk(umkSeed: Data, serverId: String) -> Data? {
        guard umkSeed.count == 32 else { return nil }
        return hkdfSha256(ikm: umkSeed, info: Data("\(infoSWK)|\(serverId)".utf8))
    }

    public static func deriveStkSeed(umkSeed: Data, serverId: String) -> Data? {
        guard let swk = deriveSwk(umkSeed: umkSeed, serverId: serverId) else { return nil }
        return hkdfSha256(ikm: swk, info: Data(infoSTK.utf8))
    }

    /// The box's STK Ed25519 PUBLIC key (32 bytes), derived from the phone's
    /// own UMK — the trust anchor for verifying STK-signed reports.
    public static func deriveStkPub(umkSeed: Data, serverId: String) -> Data? {
        guard let seed = deriveStkSeed(umkSeed: umkSeed, serverId: serverId),
              let priv = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        else { return nil }
        return priv.publicKey.rawRepresentation
    }

    /// RFC 5869 HKDF-SHA256 with an EMPTY salt — the TS protocol passes
    /// `new Uint8Array(0)`. HMAC zero-pads short keys to the block size, so
    /// CryptoKit's empty-salt HMAC key is byte-identical to noble's
    /// HashLen-zeros default.
    private static func hkdfSha256(ikm: Data, info: Data, outputByteCount: Int = 32) -> Data {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: Data(),
            info: info,
            outputByteCount: outputByteCount
        )
        return key.withUnsafeBytes { Data($0) }
    }
}
