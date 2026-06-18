import Foundation
import CryptoKit

/// Swift mirror of the box SWK derivation in `packages/protocol/src/keys.ts`
/// (`deriveSWK`): the phone provisions each box's SWK from its UMK.
///
///   SWK = HKDF-SHA256(ikm = UMK seed, salt = empty, info = "flagship.swk.v1|<serverId>", 32)
///
/// The box's identity key (STK) is NOT derived from anything: a box makes it
/// at install and the phone pins it at the first blessing (`ServerKeyPins`,
/// docs/first-contact.md). NOTE: this is the PROTOCOL info string
/// (dot-separated, from keys.ts) — distinct from the iOS Keystore's app-backup
/// SWK ("flagship/swk/v1|…"), which never has to match the box.
public enum ServerKeys {
    private static let infoSWK = "flagship.swk.v1"
    /// PROTOCOL IRK info (dot-separated) — `packages/protocol/src/keys.ts`
    /// `INFO_IRK`. DISTINCT from the iOS `Keystore`'s slash-form `flagship/irk/v1`:
    /// the iOS Keystore derives its own (registered) account IRK, whereas a box
    /// provisioned by the protocol / webapp (e.g. the gym `provision-for-webapp.ts`,
    /// which signs with `@flagship/protocol`'s `deriveIRK`) pins THIS dot-form IRK.
    private static let infoIRK = "flagship.irk.v1"

    /// The PROTOCOL account IRK Ed25519 keypair, byte-identical to the TS
    /// `deriveIRK(umk)` and the webapp's `keystore.js` `deriveIRK`. Returns nil on
    /// a malformed seed. USE: the gym live-adopt seam only (production iOS pairing
    /// uses `Keystore.deriveIRK` — the slash-form the iOS app registers).
    public static func deriveProtocolIrk(umkSeed: Data) -> Curve25519.Signing.PrivateKey? {
        guard umkSeed.count == 32 else { return nil }
        let irkSeed = hkdfSha256(ikm: umkSeed, info: Data(infoIRK.utf8))
        return try? Curve25519.Signing.PrivateKey(rawRepresentation: irkSeed)
    }

    public static func deriveSwk(umkSeed: Data, serverId: String) -> Data? {
        guard umkSeed.count == 32 else { return nil }
        return hkdfSha256(ikm: umkSeed, info: Data("\(infoSWK)|\(serverId)".utf8))
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
