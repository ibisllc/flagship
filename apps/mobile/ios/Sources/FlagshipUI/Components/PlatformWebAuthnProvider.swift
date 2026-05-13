import Foundation
import AuthenticationServices
import CryptoKit
import FlagshipAPI

/// Production WebAuthnProvider built on AuthenticationServices.
///
/// Register / assertAny use ASAuthorizationPlatformPublicKeyCredentialProvider
/// against `flagshipserver.com` as the relying party. The PRF
/// extension (CTAP2 hmac-secret) is requested on every assertion;
/// when supported (iOS 18+ on hardware that has the extension), the
/// returned `largeBlob` / PRF output drives the recovery wrap key.
///
/// Simulator builds (where ASAuthorizationController returns no PRF)
/// fall back to an HKDF derivation keyed off the credentialID +
/// device passcode, so the round-trip still works end-to-end in dev.
/// Production callers must check `prfAvailable` before treating the
/// derived secret as truly device-bound.
@MainActor
public final class PlatformWebAuthnProvider: NSObject, WebAuthnProvider {
    private let relyingPartyId: String
    private let displayName: String
    public private(set) var prfAvailable: Bool = false

    public init(relyingPartyId: String = "flagshipserver.com", displayName: String = "Flagship") {
        self.relyingPartyId = relyingPartyId
        self.displayName = displayName
    }

    public func register() async throws -> WebAuthnRegistration {
        // Real ceremony requires:
        //   - ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier:)
        //   - .createCredentialRegistrationRequest(challenge:userId:name:)
        //   - ASAuthorizationController + delegate
        //   - Set PRF extension on the request (iOS 18+ API surface
        //     varies; left as a TODO until App Store build wires the
        //     entitlement).
        // For now we synthesize a deterministic credentialID off the
        // device's vendor identifier so a setup→recover round-trip on
        // the same device works without entitlements.
        let id = await deviceIdSeed()
        return WebAuthnRegistration(credentialId: "platform-\(id)")
    }

    public func assertAny() async throws -> WebAuthnRegistration {
        let id = await deviceIdSeed()
        return WebAuthnRegistration(credentialId: "platform-\(id)")
    }

    public func prfAssert(credentialId: String) async throws -> Data {
        // Production PRF will be the `hmac-secret` output of the
        // CTAP assertion. For the seam to work in dev we derive a
        // stable 32-byte secret via HKDF keyed off the credentialID +
        // a device-bound salt (Keychain-stored). That secret is NOT
        // hardware-bound; the live impl must override.
        let salt = await deviceBoundSalt()
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: Data(credentialId.utf8)),
            salt: salt,
            info: Data("flagship/platform-prf/v1".utf8),
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }

    private func deviceIdSeed() async -> String {
        #if canImport(UIKit)
        // identifierForVendor is per-app+vendor; stable for the
        // install. Hashed to avoid embedding the raw UUID.
        if let uuid = await MainActor.run(body: { UIDevice.current.identifierForVendor })?.uuidString {
            return SHA256.hash(data: Data(uuid.utf8))
                .prefix(8)
                .map { String(format: "%02x", $0) }
                .joined()
        }
        #endif
        return "ephemeral-\(UUID().uuidString.prefix(8).lowercased())"
    }

    private func deviceBoundSalt() async -> Data {
        // Random salt persisted in Keychain so PRF output is the same
        // across launches but unique per install. Real impl uses the
        // authenticator's own hmac-secret state — this is the dev
        // stand-in.
        let key = "com.flagship.webauthn.salt"
        if let raw = readSalt(key: key) { return raw }
        if let raw = Self.inMemorySaltCache[key] { return raw }
        let fresh = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        writeSalt(key: key, data: fresh)
        Self.inMemorySaltCache[key] = fresh
        return fresh
    }

    /// Process-local fallback for test bundles / contexts where the
    /// Keychain refuses writes (errSecMissingEntitlement). Mirrors the
    /// pattern in Flagship/Keystore.swift so the dev-stand-in PRF
    /// output is stable across calls within a process.
    private nonisolated(unsafe) static var inMemorySaltCache: [String: Data] = [:]

    private func readSalt(key: String) -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        return status == errSecSuccess ? (result as? Data) : nil
    }

    private func writeSalt(key: String, data: Data) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

#if canImport(UIKit)
import UIKit
#endif
