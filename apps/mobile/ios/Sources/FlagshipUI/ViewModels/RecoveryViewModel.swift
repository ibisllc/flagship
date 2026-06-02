import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipCore
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
    /// The account whose UMK is being escrowed. The Worker REQUIRES it in
    /// the signed upload (it fetches the IRK pubkey by username + verifies
    /// the signature under it). The recover path doesn't need it — a fresh
    /// phone has no username yet — so it defaults to nil.
    private let username: () -> String?

    public init(
        client: any FlagshipServerClient,
        webAuthn: WebAuthnProvider = MockWebAuthnProvider(),
        username: @escaping () -> String? = { nil }
    ) {
        self.client = client
        self.webAuthn = webAuthn
        self.username = username
    }

    /// Register the user's authenticator + ship a recovery envelope
    /// for the current Keystore-held UMK. Caller is expected to have
    /// already generated the UMK (`Keystore.generateUMK(...)` once).
    public func setup(umkSeed: SymmetricKey) async {
        phase = .settingUp
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        do {
            let registration = try await webAuthn.register()
            let prfSecret = try await webAuthn.prfAssert(credentialId: registration.credentialId)
            // Single self-contained AES-GCM blob (nonce‖ct‖tag). The Worker
            // base64-decodes it and SHA-256s the bytes; we hash the same
            // bytes to put into the signed canonical.
            let wrappedUmk = try Recovery.wrap(umkSeed: umkSeed, prfSecret: prfSecret)
            guard let wrappedUmkBytes = Data(base64Encoded: wrappedUmk) else {
                phase = .failed("Local base64 round-trip failed")
                return
            }
            let wrappedUmkHashHex = RecoveryUpload.wrappedUmkHashHex(wrappedUmkBytes)

            // #28 — also escrow the ACME account key (cert-minting authority)
            // under the SAME PRF secret so a fully device-less recovery can
            // restore issuance. UMK escrow is primary: a failure to mint or
            // wrap the account key must NOT fail recovery setup, so this is a
            // best-effort do/catch that simply omits the field on error. The
            // account key uses its OWN wrap (salt flagship/recovery-acme-wrap/v1).
            var wrappedAcme: String? = nil
            do {
                let acme = try Keystore.loadOrCreateAcmeAccountKey()
                wrappedAcme = try AcmeAccountKey.wrapForEscrow(
                    scalar: acme.rawRepresentation,
                    prfSecret: prfSecret
                )
            } catch {
                // Non-fatal: continue without the escrowed account key.
            }

            // Sign the UploadRecoveryRecord under the account IRK. The
            // signature covers the HASH of the ciphertext + the credentialId
            // + username + issuedAt — exactly what the Worker re-derives and
            // verifies. credentialId is the WebAuthn credential, already hex.
            let irk = try await Keystore.deriveIRK(reason: "Back up your Flagship account")
            let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
            let signature = try RecoveryUpload.sign(
                username: user,
                credentialIdHex: registration.credentialId,
                wrappedUmkHashHex: wrappedUmkHashHex,
                issuedAt: issuedAt,
                irk: irk
            )

            _ = try await client.registerRecoveryEnvelope(.init(
                request: .init(
                    username: user,
                    credentialId: registration.credentialId,
                    wrappedUmk: wrappedUmk,
                    issuedAt: issuedAt,
                    wrappedAcmeAccountKey: wrappedAcme
                ),
                signature: signature
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
                wrappedUmkBase64: env.wrappedUmk,
                prfSecret: prfSecret
            )
            // #28 — if the envelope carries the escrowed ACME account key,
            // unwrap it under the same PRF secret and import it so this
            // recovered device regains cert-minting authority. Non-fatal:
            // UMK recovery is primary, and accounts that never minted an
            // account key simply won't carry this field.
            if let wrappedAcme = env.wrappedAcmeAccountKey {
                do {
                    let scalar = try AcmeAccountKey.unwrapFromEscrow(
                        base64: wrappedAcme,
                        prfSecret: prfSecret
                    )
                    try Keystore.importAcmeAccountKey(scalar: scalar)
                } catch {
                    // Non-fatal: the UMK is recovered; account-key restore
                    // can be retried (re-mint + re-escrow) later.
                }
            }
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
