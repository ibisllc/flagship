import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// E2 — Wipe & restart orchestrator. Rotates everything the user can
/// rotate, in one atomic ceremony:
///
///   1. Generate a fresh UMK seed locally.
///   2. Run WebAuthn passkey REGISTER → new credentialID.
///   3. PRF-assert against the new credential → 32-byte secret.
///   4. AES-GCM wrap the NEW UMK under the new PRF secret →
///      new wrappedUmk + nonce.
///   5. Compute SHA-256 of the new wrappedUmk so the canonical bytes
///      stay small (the protocol signs the HASH of the ciphertext,
///      not the ciphertext itself).
///   6. Derive OLD IRK (from current UMK) — this device's existing
///      authority. The OLD IRK signs the WipeRestart envelope, which
///      is the trust basis that lets .com swap the registered IRK.
///   7. Derive NEW IRK from the NEW UMK at v1 — what the device will
///      use going forward.
///   8. Sign canonical flagship/wipe-restart/v1 bytes with the OLD IRK.
///   9. POST /api/users/:u/wipe-restart with body + 16-byte
///      idempotencyKey. Server CAS-swaps IRK + envelope + appends
///      audit row atomically.
///  10. On 200: install the NEW UMK into Keystore (which resets the
///      IRK version slot). Local state now matches what .com just
///      committed.
///
/// Failure handling is conservative: until step 10 succeeds, Keystore
/// retains the OLD UMK — so a network blip on the POST doesn't strand
/// the user with mismatched local + server keys.
@Observable
@MainActor
public final class WipeRestartViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case preparingKeys
        case registeringPasskey
        case wrappingNewUmk
        case signing
        case posting
        case installingLocally
        case completed
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let server: FlagshipServerClient
    private let webAuthn: WebAuthnProvider
    private let username: () -> String?

    public init(
        server: FlagshipServerClient,
        webAuthn: WebAuthnProvider = MockWebAuthnProvider(),
        username: @escaping () -> String?
    ) {
        self.server = server
        self.webAuthn = webAuthn
        self.username = username
    }

    /// Run the ceremony. `currentEtag` is the value the caller
    /// captured from its most recent `listDevices` call — passed as
    /// `If-Match` to fence the device-list-shifted race. Pass nil
    /// to skip the fence (the rate limit + signature gate still apply).
    public func run(currentEtag: String?) async {
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }

        // 1 — Materialize OLD + NEW UMKs.
        phase = .preparingKeys
        let oldUmk: SymmetricKey
        do {
            oldUmk = try await Keystore.currentUMK(reason: "Wipe & restart")
        } catch {
            phase = .failed("Couldn't access your current account key: \(error.localizedDescription)")
            return
        }
        let newUmk = SymmetricKey(size: .bits256)

        // 2 — Register a fresh passkey.
        phase = .registeringPasskey
        let registration: WebAuthnRegistration
        do {
            registration = try await webAuthn.register()
        } catch {
            phase = .failed("Passkey registration failed: \(error.localizedDescription)")
            return
        }
        // 3 — PRF assert against the new credential.
        let prfSecret: Data
        do {
            prfSecret = try await webAuthn.prfAssert(credentialId: registration.credentialId)
        } catch {
            phase = .failed("PRF assertion failed: \(error.localizedDescription)")
            return
        }

        // 4 — Wrap the NEW UMK under the new PRF secret.
        phase = .wrappingNewUmk
        let wrapped: (ciphertextBase64: String, nonceBase64: String)
        do {
            wrapped = try Recovery.wrap(umkSeed: newUmk, prfSecret: prfSecret)
        } catch {
            phase = .failed("Couldn't wrap new key: \(error.localizedDescription)")
            return
        }
        // The Worker stores wrappedUmk as a single base64 string that
        // it decodes + hashes. The Worker's canonical bytes also
        // SHA-256 the decoded ciphertext bytes (NOT base64 chars), so
        // we feed it the raw nonce||ct bytes the SealedBox produces.
        guard let nonceBytes = Data(base64Encoded: wrapped.nonceBase64),
              let ctBytes = Data(base64Encoded: wrapped.ciphertextBase64)
        else {
            phase = .failed("Local base64 round-trip failed")
            return
        }
        let combined = nonceBytes + ctBytes
        let newWrappedUmkB64 = combined.base64EncodedString()
        let wrappedHashHex = sha256Hex(combined)

        // 5 — Derive OLD + NEW IRK pub keys.
        phase = .signing
        let oldIrk: Curve25519.Signing.PrivateKey
        let newIrkPubHex: String
        do {
            oldIrk = try await Keystore.deriveIRK(
                reason: "Authorize wipe",
                version: Keystore.currentIrkVersion()
            )
            // The NEW IRK derives from the NEW UMK at v1. We don't
            // persist it until step 7 (post-success install), but we
            // need its pub to put in the WipeRestart envelope.
            let newIrkSeed = HKDF<SHA256>.deriveKey(
                inputKeyMaterial: newUmk,
                info: Data("flagship/irk/v1".utf8),
                outputByteCount: 32,
            )
            let newIrkKey = try Curve25519.Signing.PrivateKey(
                rawRepresentation: newIrkSeed.withUnsafeBytes { Data($0) }
            )
            newIrkPubHex = HexUtil.encode(newIrkKey.publicKey.rawRepresentation)
        } catch {
            phase = .failed("Couldn't derive identity keys: \(error.localizedDescription)")
            return
        }
        let oldIrkPubHex = HexUtil.encode(oldIrk.publicKey.rawRepresentation)
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let canonical = WipeRestartClaim.canonicalBytes(
            username: user,
            oldIrkPubHex: oldIrkPubHex,
            newIrkPubHex: newIrkPubHex,
            newCredentialIdHex: registration.credentialId,
            newWrappedUmkHashHex: wrappedHashHex,
            issuedAt: issuedAt,
        )
        let signature: Data
        do {
            signature = try oldIrk.signature(for: canonical)
        } catch {
            phase = .failed("Couldn't sign: \(error.localizedDescription)")
            return
        }

        // 6 — POST.
        phase = .posting
        let idempotencyKey = randomIdempotencyKey()
        do {
            _ = try await server.wipeRestart(
                username: user,
                body: WipeRestartRequest(
                    request: .init(
                        username: user,
                        oldIrkPub: oldIrkPubHex,
                        newIrkPub: newIrkPubHex,
                        newCredentialId: registration.credentialId,
                        newWrappedUmk: newWrappedUmkB64,
                        issuedAt: issuedAt,
                    ),
                    signature: HexUtil.encode(signature),
                    idempotencyKey: idempotencyKey,
                ),
                ifMatch: currentEtag,
            )
        } catch ScreensClientError.http(let status, _) where status == 412 {
            phase = .failed("Your device list changed in the background. Refresh and try again.")
            return
        } catch ScreensClientError.http(let status, _) where status == 429 {
            phase = .failed("Wipe rate-limited (1 per hour). Try again later.")
            return
        } catch ScreensClientError.http(let status, _) where status == 409 {
            phase = .failed("Another rotation completed first. Your account is fine — refresh and check Activity for the audit trail.")
            return
        } catch {
            phase = .failed("Couldn't reach the server: \(error.localizedDescription)")
            return
        }

        // 7 — Atomic local install. From this point the device's
        // Keystore matches what .com just committed.
        phase = .installingLocally
        do {
            try await Keystore.installUMK(newUmk, reason: "Activate new account key")
        } catch {
            // Worst case here: server committed but local install
            // failed. The peer-detection mechanism (E7) will catch
            // it on next foreground via /api/users/:u/devices, and
            // the user will be prompted to sign in again — which
            // is the right recovery path.
            phase = .failed("Server committed but local install failed: \(error.localizedDescription). Open the app fresh to recover.")
            return
        }
        // Bonus on success: forget OUR push token so we don't try
        // to push-relay to a now-invalid identity. Re-registration
        // happens on next launch via PushRegistrar.
        try? Keystore.setPushTokenId(nil)
        phase = .completed
    }

    // MARK: - helpers

    private func sha256Hex(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func randomIdempotencyKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
