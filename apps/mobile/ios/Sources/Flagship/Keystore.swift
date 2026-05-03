import Foundation
import CryptoKit
import LocalAuthentication
import Security

/// Generates and holds the User Master Key (UMK) inside the Secure Enclave when
/// available. Derived keys (BAK, IRK, SWK) are produced via HKDF on demand and
/// never persisted unwrapped.
public struct Keystore {

    public enum KeystoreError: Error {
        case secureEnclaveUnavailable
        case keyNotFound
        case biometricFailed(OSStatus)
        case derivationFailed
    }

    private static let umkTag = "com.flagship.umk".data(using: .utf8)!

    /// Generate a fresh UMK seed, store it Secure-Enclave-protected, and require
    /// biometric (or device passcode) for subsequent reads.
    public static func generateUMK() throws {
        let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryAny],
            nil
        )!
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: umkTag,
                kSecAttrAccessControl as String: access,
            ],
        ]
        var error: Unmanaged<CFError>?
        guard SecKeyCreateRandomKey(attrs as CFDictionary, &error) != nil else {
            throw error!.takeRetainedValue() as Error
        }
    }

    /// Derive a 32-byte SWK for the given server.
    public static func deriveSWK(serverId: String, biometric: BiometricGate) async throws -> SymmetricKey {
        let umkBytes = try await unwrappedUMK(reason: "Authorize backup key for \(serverId)", biometric: biometric)
        let info = "flagship.swk.v1|\(serverId)".data(using: .utf8)!
        return SymmetricKey(data: HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: umkBytes),
            info: info,
            outputByteCount: 32
        ))
    }

    /// Derive an Ed25519 BAK keypair for the given server. Used to sign boot challenges.
    public static func deriveBAK(serverId: String, biometric: BiometricGate) async throws -> Curve25519.Signing.PrivateKey {
        let umkBytes = try await unwrappedUMK(reason: "Authorize boot for \(serverId)", biometric: biometric)
        let info = "flagship.bak.v1|\(serverId)".data(using: .utf8)!
        let seed = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: umkBytes),
            info: info,
            outputByteCount: 32
        )
        return try Curve25519.Signing.PrivateKey(rawRepresentation: seed.withUnsafeBytes { Data($0) })
    }

    /// Derive an Ed25519 IRK keypair. Used to sign image-rebuild and revocation requests.
    public static func deriveIRK(biometric: BiometricGate) async throws -> Curve25519.Signing.PrivateKey {
        let umkBytes = try await unwrappedUMK(reason: "Authorize account-level operation", biometric: biometric)
        let info = "flagship.irk.v1".data(using: .utf8)!
        let seed = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: umkBytes),
            info: info,
            outputByteCount: 32
        )
        return try Curve25519.Signing.PrivateKey(rawRepresentation: seed.withUnsafeBytes { Data($0) })
    }

    private static func unwrappedUMK(reason: String, biometric: BiometricGate) async throws -> Data {
        try await biometric.evaluate(reason: reason)
        // TODO: in a fuller implementation the SecKey lookup, ECDH-derived
        // KEK, and the wrapped 32-byte UMK seed live here. Sketched for the
        // scaffold; see key_hierarchy.md for the full design.
        throw KeystoreError.derivationFailed
    }
}
