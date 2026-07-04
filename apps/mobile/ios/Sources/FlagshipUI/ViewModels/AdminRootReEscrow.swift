import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Slice D §5.3 (D-3) / §8.4 — re-wrap the CURRENT admin master root under the
/// EXISTING WebAuthn-PRF recovery credential after a rotation.
///
/// A rotation replaces the account's authority root, but the recovery envelope
/// still escrows the OLD (dead) root — a later credential recovery would
/// restore a key no box accepts. This re-derives the wrap key from the user's
/// recovery passphrase (Argon2id → prfSalt → PRF assert against the SAME
/// credential; NO new passkey is registered) and replaces ONLY
/// `wrappedAdminRoot` in the stored record, passing the wrapped UMK and ACME
/// key through byte-unchanged. Same credentialId ⇒ the Worker upserts the
/// record in place, so a later restore transparently yields the rotated root.
///
/// Consent-as-crypto: the passphrase + WebAuthn UV EMIT the wrap key, and the
/// biometric-gated IRK derive EMITS the upload signature — no step here is a
/// cosmetic boolean.
///
/// Ordering invariant: the wrap key is PROVEN right (the fetched wrappedUmk
/// must unwrap under the asserted PRF secret) BEFORE anything is uploaded, so
/// a wrong credential / tampered salt / PRF drift can never overwrite a
/// working escrow with an undecryptable one.
public struct AdminRootReEscrow: Sendable {

    public enum ReEscrowError: Error, LocalizedError, Equatable {
        /// The gated fetch 403'd — the passphrase didn't derive the stored
        /// fetchToken.
        case wrongPassphrase
        /// `.com` returned a prfSaltHash that doesn't match the locally
        /// derived salt (same anti-coercion check as RecoveryViewModel.recover).
        case prfSaltMismatch
        /// The fetched wrappedUmk did NOT unwrap under the asserted PRF
        /// secret — the wrap key is wrong, so uploading would brick recovery.
        case wrapKeySanityFailed
        /// The fetched envelope's wrappedUmk isn't valid base64.
        case malformedEnvelope

        public var errorDescription: String? {
            switch self {
            case .wrongPassphrase:
                return "That passphrase didn't match."
            case .prfSaltMismatch:
                return "Server returned a stale prfSaltHash — refusing to proceed."
            case .wrapKeySanityFailed:
                return "Couldn't verify your recovery credential — your recovery backup was left unchanged."
            case .malformedEnvelope:
                return "Your stored recovery backup looks corrupted — re-run recovery setup."
            }
        }
    }

    private let client: any FlagshipServerClient
    private let webAuthn: any WebAuthnProvider
    private let loadAdminRoot: @Sendable (String) async throws -> Curve25519.Signing.PrivateKey
    private let deriveIRK: @Sendable (String) async throws -> Curve25519.Signing.PrivateKey

    public init(
        client: any FlagshipServerClient,
        webAuthn: any WebAuthnProvider,
        loadAdminRoot: @escaping @Sendable (String) async throws -> Curve25519.Signing.PrivateKey = { reason in
            try await Keystore.adminRootKey(reason: reason)
        },
        deriveIRK: @escaping @Sendable (String) async throws -> Curve25519.Signing.PrivateKey = { reason in
            try await Keystore.deriveIRK(reason: reason)
        }
    ) {
        self.client = client
        self.webAuthn = webAuthn
        self.loadAdminRoot = loadAdminRoot
        self.deriveIRK = deriveIRK
    }

    public func run(username: String, passphrase: String) async throws {
        // Argon2id (~1-2s). `run` is nonisolated-async, so the hashing executes
        // on the concurrency pool, off the main actor.
        let secrets = try RecoveryDerivation.derivePassphraseSecrets(passphrase, username)

        // The gate: a wrong passphrase derives the wrong fetchToken → 403.
        let fetched: RecoveryFetchResponse
        do {
            fetched = try await client.fetchWrappedUmk(
                username: username,
                fetchTokenHex: HexUtil.encode(secrets.fetchToken)
            )
        } catch ScreensClientError.http(let status, _) where status == 403 {
            throw ReEscrowError.wrongPassphrase
        }

        // Anti-coercion: a tampered `.com` feeding a different salt would
        // otherwise surface only as an opaque AES-GCM tag mismatch.
        if let serverPrfSaltHash = fetched.prfSaltHash {
            guard RecoveryDerivation.sha256Hex(secrets.prfSalt) == serverPrfSaltHash.lowercased() else {
                throw ReEscrowError.prfSaltMismatch
            }
        }

        // PRF assert against the EXISTING credential (no register()).
        let prfSecret = try await webAuthn.prfAssert(
            credentialId: fetched.credentialId,
            prfSalt: secrets.prfSalt
        )

        // Sanity gate: prove the wrap key is right BEFORE overwriting the
        // stored record — the fetched wrappedUmk must unwrap under it.
        do {
            _ = try Recovery.unwrap(wrappedUmkBase64: fetched.wrappedUmk, prfSecret: prfSecret)
        } catch {
            throw ReEscrowError.wrapKeySanityFailed
        }

        // The CURRENT (post-rotation) admin root, re-wrapped for escrow.
        let adminKey = try await loadAdminRoot("Update your recovery backup")
        let wrappedAdminRoot = try AdminRootEscrow.wrapForEscrow(
            seed: adminKey.rawRepresentation,
            prfSecret: prfSecret
        )

        // Sign the SAME upload canonical RecoveryViewModel.setup posts — over
        // the PASSED-THROUGH wrappedUmk bytes, the unchanged credentialId.
        guard let wrappedUmkBytes = Data(base64Encoded: fetched.wrappedUmk) else {
            throw ReEscrowError.malformedEnvelope
        }
        let irk = try await deriveIRK("Update your recovery backup")
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let signature = try RecoveryUpload.sign(
            username: username,
            credentialIdHex: fetched.credentialId,
            wrappedUmkHashHex: RecoveryUpload.wrappedUmkHashHex(wrappedUmkBytes),
            issuedAt: issuedAt,
            irk: irk
        )

        _ = try await client.registerRecoveryEnvelope(.init(
            request: .init(
                username: username,
                credentialId: fetched.credentialId,
                wrappedUmk: fetched.wrappedUmk,
                issuedAt: issuedAt,
                wrappedAcmeAccountKey: fetched.wrappedAcmeAccountKey,
                wrappedAdminRoot: wrappedAdminRoot,
                fetchTokenHash: RecoveryDerivation.sha256Hex(secrets.fetchToken),
                prfSaltHash: RecoveryDerivation.sha256Hex(secrets.prfSalt)
            ),
            signature: signature
        ))
    }
}
