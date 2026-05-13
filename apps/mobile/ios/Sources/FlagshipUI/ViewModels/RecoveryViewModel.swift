import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI

/// Owns the WebAuthn-PRF cloud-recovery flow.
///
/// Setup phase calls into Recovery.wrap(...) using a passkey-derived
/// PRF secret, then ships the envelope via FlagshipServerClient. The
/// recover phase reverses it.
///
/// PRF assertion against a real passkey lives behind the
/// `webAuthnProvider` injection seam — UI/test code can stub it. The
/// production provider will be a thin wrapper around
/// ASAuthorizationController + the PRF extension.
@Observable
@MainActor
public final class RecoveryViewModel {
    public enum Phase: Sendable {
        case idle
        case settingUp
        case registered(credentialId: String)
        case recovering
        case recovered
        case failed(String)
    }

    public var phase: Phase = .idle

    private let client: any FlagshipServerClient
    private let webAuthn: WebAuthnProvider

    public init(client: any FlagshipServerClient, webAuthn: WebAuthnProvider = MockWebAuthnProvider()) {
        self.client = client
        self.webAuthn = webAuthn
    }

    /// Register the user's authenticator + ship a recovery envelope
    /// for the current Keystore-held UMK. Caller is expected to have
    /// already generated the UMK (`Keystore.generateUMK(...)` once).
    public func setup(umkSeed: SymmetricKey) async {
        phase = .settingUp
        do {
            let registration = try await webAuthn.register()
            let prfSecret = try await webAuthn.prfAssert(credentialId: registration.credentialId)
            let env = try Recovery.wrap(umkSeed: umkSeed, prfSecret: prfSecret)
            _ = try await client.registerRecoveryEnvelope(.init(
                credentialId: registration.credentialId,
                wrappedUmkBase64: env.ciphertextBase64,
                nonceBase64: env.nonceBase64
            ))
            phase = .registered(credentialId: registration.credentialId)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Recover the UMK on a fresh phone. Returns the recovered seed
    /// (caller injects it into Keystore via a hypothetical
    /// `Keystore.installUMK(seed:)` — not implemented here yet).
    public func recover() async -> SymmetricKey? {
        phase = .recovering
        do {
            let prompt = try await webAuthn.assertAny()
            let env = try await client.fetchRecoveryEnvelope(credentialId: prompt.credentialId)
            let prfSecret = try await webAuthn.prfAssert(credentialId: prompt.credentialId)
            let seed = try Recovery.unwrap(
                ciphertextBase64: env.wrappedUmkBase64,
                nonceBase64: env.nonceBase64,
                prfSecret: prfSecret
            )
            phase = .recovered
            return seed
        } catch {
            phase = .failed(error.localizedDescription)
            return nil
        }
    }
}

/// Abstraction over the platform's WebAuthn + PRF assertion API. Live
/// impl wraps ASAuthorizationController; tests + previews use the
/// mock which generates deterministic credentialIds + PRF secrets.
public protocol WebAuthnProvider: Sendable {
    func register() async throws -> WebAuthnRegistration
    func assertAny() async throws -> WebAuthnRegistration
    func prfAssert(credentialId: String) async throws -> Data
}

public struct WebAuthnRegistration: Sendable {
    public let credentialId: String
    public init(credentialId: String) { self.credentialId = credentialId }
}

/// Mock provider — deterministic PRF secret per credentialId so a
/// setup + recover round-trip works in tests.
public final class MockWebAuthnProvider: WebAuthnProvider, @unchecked Sendable {
    public init() {}
    public func register() async throws -> WebAuthnRegistration {
        WebAuthnRegistration(credentialId: "mock-cred-\(UUID().uuidString.prefix(8))")
    }
    public func assertAny() async throws -> WebAuthnRegistration {
        WebAuthnRegistration(credentialId: "mock-cred-existing")
    }
    public func prfAssert(credentialId: String) async throws -> Data {
        // HKDF a stable secret keyed on the credentialId.
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: Data(credentialId.utf8)),
            salt: Data("flagship/mock-prf/v1".utf8),
            info: Data(),
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }
}
