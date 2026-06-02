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

    /// Register the user's authenticator + ship a recovery envelope for
    /// the current Keystore-held UMK, gated behind a recovery PASSPHRASE
    /// (Task #4). Caller is expected to have already generated the UMK
    /// (`Keystore.generateUMK(...)` once).
    ///
    /// The passphrase (entered twice in the UI, min 8 chars) is
    /// Argon2id-hardened into `{fetchToken, prfSalt}` exactly as
    /// recovery.js does. `prfSalt` feeds WebAuthn's PRF so the wrap key is
    /// bound to the passphrase; `SHA-256(fetchToken)` + `SHA-256(prfSalt)`
    /// are shipped in the signed `/api/recovery` request so a later device
    /// can gate-fetch the ciphertext and verify the salt.
    public func setup(umkSeed: SymmetricKey, passphrase: String) async {
        phase = .settingUp
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        guard passphrase.count >= 8 else {
            phase = .failed("Passphrase must be 8+ characters.")
            return
        }
        do {
            // Argon2id (~1-2s) → fetchToken + prfSalt. Mirrors recovery.js.
            let secrets = try RecoveryDerivation.derivePassphraseSecrets(passphrase, user)

            // Create the passkey with PRF input = prfSalt, then PRF-assert
            // to get the 32-byte secret. credentialId is lowercase hex of
            // the raw credential-ID bytes (Worker requires ^[0-9a-fA-F]+$).
            let registration = try await webAuthn.register(prfSalt: secrets.prfSalt)
            let credentialIdHex = Self.credentialIdHex(registration.credentialId)
            let prfSecret = try await webAuthn.prfAssert(
                credentialId: registration.credentialId,
                prfSalt: secrets.prfSalt
            )
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
            // verifies. The fetchToken/prfSalt hashes ride OUTSIDE the signed
            // canonical (the Worker accepts-if-present; they're hashes of
            // passphrase-derived secrets, not forgeable into a different UMK).
            let irk = try await Keystore.deriveIRK(reason: "Back up your Flagship account")
            let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
            let signature = try RecoveryUpload.sign(
                username: user,
                credentialIdHex: credentialIdHex,
                wrappedUmkHashHex: wrappedUmkHashHex,
                issuedAt: issuedAt,
                irk: irk
            )

            _ = try await client.registerRecoveryEnvelope(.init(
                request: .init(
                    username: user,
                    credentialId: credentialIdHex,
                    wrappedUmk: wrappedUmk,
                    issuedAt: issuedAt,
                    wrappedAcmeAccountKey: wrappedAcme,
                    fetchTokenHash: RecoveryDerivation.sha256Hex(secrets.fetchToken),
                    prfSaltHash: RecoveryDerivation.sha256Hex(secrets.prfSalt)
                ),
                signature: signature
            ))
            phase = .registered(credentialId: credentialIdHex)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Recover the UMK on a fresh phone from a username + recovery
    /// passphrase (Task #4 — the gated fetch). Returns the recovered seed
    /// (the caller installs it via `Keystore.installUMK`).
    ///
    /// Flow (mirrors recovery.js `recover`):
    ///   1. Argon2id(passphrase, username) → fetchToken + prfSalt.
    ///   2. `POST /api/recovery/by-username/<u>/fetch` with the fetchToken;
    ///      `.com` releases the ciphertext only on a matching SHA-256.
    ///   3. Verify `SHA-256(local prfSalt) == response.prfSaltHash` —
    ///      refuse on mismatch (anti-coercion).
    ///   4. PRF get() with input = prfSalt → unwrap the UMK (+ #28 ACME key).
    public func recover(username user: String, passphrase: String) async -> SymmetricKey? {
        phase = .recovering
        let normalizedUser = user.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalizedUser.isEmpty else {
            phase = .failed("Enter your account name.")
            return nil
        }
        guard passphrase.count >= 8 else {
            phase = .failed("Passphrase must be 8+ characters.")
            return nil
        }
        do {
            let secrets = try RecoveryDerivation.derivePassphraseSecrets(passphrase, normalizedUser)

            // The gate: present the fetchToken; a wrong passphrase → 403.
            let fetched = try await client.fetchWrappedUmk(
                username: normalizedUser,
                fetchTokenHex: HexUtil.encode(secrets.fetchToken)
            )

            // Anti-coercion: confirm the server returned the same prfSalt we
            // derived locally. A tampered `.com` feeding a different salt
            // would otherwise surface only as an opaque AES-GCM tag mismatch.
            if let serverPrfSaltHash = fetched.prfSaltHash {
                let localPrfSaltHash = RecoveryDerivation.sha256Hex(secrets.prfSalt)
                guard localPrfSaltHash == serverPrfSaltHash.lowercased() else {
                    phase = .failed("Server returned a stale prfSaltHash — refusing to proceed.")
                    return nil
                }
            }

            // PRF get() against the released credential, salt = prfSalt.
            let prfSecret = try await webAuthn.prfAssert(
                credentialId: fetched.credentialId,
                prfSalt: secrets.prfSalt
            )
            let seed = try Recovery.unwrap(
                wrappedUmkBase64: fetched.wrappedUmk,
                prfSecret: prfSecret
            )
            // #28 — if the envelope carries the escrowed ACME account key,
            // unwrap it under the same PRF secret and import it so this
            // recovered device regains cert-minting authority. Non-fatal:
            // UMK recovery is primary, and accounts that never minted an
            // account key simply won't carry this field.
            if let wrappedAcme = fetched.wrappedAcmeAccountKey {
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

    /// Normalize a credentialId to lowercase hex of its raw bytes — the
    /// WIRE form the Worker requires (`^[0-9a-fA-F]{16,512}$`). The real
    /// `ASAuthorization` provider yields raw credential-ID bytes; we
    /// expect those already hex-encoded. Anything already-hex passes
    /// through (lower-cased); a non-hex dev stand-in id is UTF-8→hex
    /// encoded so it still satisfies the regex deterministically.
    static func credentialIdHex(_ credentialId: String) -> String {
        let lower = credentialId.lowercased()
        let isHex = !lower.isEmpty
            && lower.count % 2 == 0
            && lower.allSatisfy { $0.isHexDigit }
        if isHex { return lower }
        return HexUtil.encode(Data(credentialId.utf8))
    }
}

/// Abstraction over the platform's WebAuthn + PRF assertion API. Live
/// impl wraps ASAuthorizationController; tests + previews use the
/// mock which generates deterministic credentialIds + PRF secrets.
///
/// The `prfSalt:` parameters carry the passphrase-derived PRF salt (Task
/// #4) into WebAuthn's `prf.eval.first`, binding the PRF output to the
/// user's passphrase exactly as recovery.js does. Callers that don't run
/// the passphrase flow (the Mock-only takeover VMs) use the no-salt
/// convenience shims below, which default the salt to a fixed value.
public protocol WebAuthnProvider: Sendable {
    func register(prfSalt: Data) async throws -> WebAuthnRegistration
    func assertAny() async throws -> WebAuthnRegistration
    func prfAssert(credentialId: String, prfSalt: Data) async throws -> Data
}

/// The default PRF salt used by the no-salt convenience overloads — keeps
/// the legacy takeover flows (RealAccountLogin / WipeRestart) deriving a
/// stable secret without threading a passphrase through them.
public let defaultWebAuthnPrfSalt = Data("flagship/recovery/v1".utf8)

public extension WebAuthnProvider {
    /// Back-compat shim: register without an explicit PRF salt.
    func register() async throws -> WebAuthnRegistration {
        try await register(prfSalt: defaultWebAuthnPrfSalt)
    }
    /// Back-compat shim: PRF-assert with the default salt.
    func prfAssert(credentialId: String) async throws -> Data {
        try await prfAssert(credentialId: credentialId, prfSalt: defaultWebAuthnPrfSalt)
    }
}

public struct WebAuthnRegistration: Sendable {
    public let credentialId: String
    public init(credentialId: String) { self.credentialId = credentialId }
}

/// Mock provider — deterministic PRF secret keyed on the PRF salt so a
/// passphrase-bound setup + recover round-trip works in tests. A real
/// authenticator keys its hmac-secret output by the salt (NOT the
/// credentialId), so we mirror that: the same passphrase derives the same
/// salt on both enroll and recover, yielding the same unwrap key even
/// when the two ceremonies surface different credentialIds.
public final class MockWebAuthnProvider: WebAuthnProvider, @unchecked Sendable {
    public init() {}
    public func register(prfSalt: Data) async throws -> WebAuthnRegistration {
        // Hex credentialId so it satisfies the Worker's ^[0-9a-fA-F]{16,512}$
        // and survives a hex→bytes→hex round-trip in tests.
        WebAuthnRegistration(
            credentialId: "aabbccdd" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        )
    }
    public func assertAny() async throws -> WebAuthnRegistration {
        // Stable id for the legacy takeover flows (RealAccountLogin /
        // WipeRestart) whose Mock recovery store is keyed by it. The new
        // passphrase-gated recover path does NOT use assertAny — it fetches
        // by username — so this value is unrelated to the gated fetch.
        WebAuthnRegistration(credentialId: "mock-cred-existing")
    }
    public func prfAssert(credentialId: String, prfSalt: Data) async throws -> Data {
        // HKDF a stable secret keyed on the PRF salt.
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: prfSalt),
            salt: Data("flagship/mock-prf/v1".utf8),
            info: Data(),
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }
}
