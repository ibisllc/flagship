import Foundation
import CryptoKit

/// Which IRK does an account hold now, given its UMK? (key-file import, the recovery path)
///
/// The clients derive the IRK from the UMK three ways, and an account holds whichever one its
/// creating client (or its last re-pair) used:
///   web      HKDF(umk, salt "",                  info "flagship.irk.v<n>")   webapp, @flagship/protocol
///   ios      HKDF(umk, salt "",                  info "flagship/irk/v<n>")   this app (Keystore.deriveIRK)
///   android  HKDF(umk, salt "flagship/irk/v<n>", info "ed25519-seed")
/// An import finds the one whose public key `.com` serves for the account, signs the re-pair's
/// credential with it, and rotates to the ios scheme at that version + 1. Only keys derived from
/// the file's own seed are tried, so `.com`'s answer can only choose among them.
/// Vectors: packages/protocol/test-vectors/irk-lineage (tools/irk-lineage-vectors.mjs).
public enum IrkLineage {
    public enum Scheme: String, CaseIterable, Sendable { case web, ios, android }

    public static let maxVersion = 16
    public static let own: Scheme = .ios

    public struct Key: Sendable {
        public let scheme: Scheme
        public let version: Int
        public let privateKey: Curve25519.Signing.PrivateKey
        public var pubHex: String { HexUtil.encode(privateKey.publicKey.rawRepresentation) }
    }

    public static func seed(umk: SymmetricKey, scheme: Scheme, version: Int) -> SymmetricKey {
        precondition(version >= 1, "IRK version must be >= 1")
        let (salt, info): (String, String)
        switch scheme {
        case .web: (salt, info) = ("", "flagship.irk.v\(version)")
        case .ios: (salt, info) = ("", "flagship/irk/v\(version)")
        case .android: (salt, info) = ("flagship/irk/v\(version)", "ed25519-seed")
        }
        return HKDF<SHA256>.deriveKey(
            inputKeyMaterial: umk, salt: Data(salt.utf8), info: Data(info.utf8), outputByteCount: 32
        )
    }

    public static func key(umk: SymmetricKey, scheme: Scheme, version: Int) throws -> Key {
        let raw = seed(umk: umk, scheme: scheme, version: version).withUnsafeBytes { Data($0) }
        return Key(scheme: scheme, version: version, privateKey: try Curve25519.Signing.PrivateKey(rawRepresentation: raw))
    }

    /// The key under `umk` whose public half is `registeredPubHex`, or nil when none of
    /// v1...maxVersion in any scheme is (another account, or a file from before the account's key
    /// was replaced). Own scheme first: the common case.
    public static func findRegistered(umk: SymmetricKey, registeredPubHex: String, maxVersion: Int = maxVersion) -> Key? {
        let want = registeredPubHex.lowercased()
        guard want.count == 64, want.allSatisfy({ $0.isHexDigit }) else { return nil }
        let order = [own] + Scheme.allCases.filter { $0 != own }
        for v in 1...maxVersion {
            for s in order {
                if let k = try? key(umk: umk, scheme: s, version: v), k.pubHex == want { return k }
            }
        }
        return nil
    }

    /// Versions only climb, so a key a re-pair displaced is never installed again.
    public static func nextVersion(after registered: Key) -> Int { registered.version + 1 }
}
