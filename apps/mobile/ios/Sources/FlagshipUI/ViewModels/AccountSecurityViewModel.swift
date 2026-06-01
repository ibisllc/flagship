import Foundation
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// v1.2 Phase 4 — drives the Settings → Multi-device + 2FA flow:
///
///   1. Load the account-type badge state from
///      `GET /api/users/:u` (single vs multi-device).
///   2. Step the user through the four-step enroll sheet (explainer
///      → QR + secret → sample code → recovery codes).
///   3. Optionally disable an existing enrollment (Phase 3 endpoint;
///      gated by the Worker on single-device-count).
///
/// The IRK signature for enroll-begin / enroll-confirm / disable is
/// produced by Keystore.deriveIRK at the current IRK version — same
/// shape as ReplaceDeviceViewModel.
///
/// Recovery codes (the ten plaintext strings returned ONCE on
/// enroll-confirm) are kept only in this view-model's `.confirmed`
/// payload — they leave the device the moment the user dismisses
/// the codes screen, which is gated behind an explicit
/// "I've saved these" tap.
@Observable
@MainActor
public final class AccountSecurityViewModel {

    /// Discriminated state machine for the enrollment sheet.
    public enum Phase: Equatable, Sendable {
        case idle
        case beginning           // signing + POST /enroll-begin in flight
        case staged(StagedSecret) // got QR + base32 secret; awaiting the sample code
        case confirming          // POST /enroll-confirm in flight
        case confirmed(EnrollmentResult)
        case disabling
        case disabled
        case failed(String)
    }

    public struct StagedSecret: Equatable, Sendable {
        public let secret: String
        public let otpauthUrl: String
        public let qrPngBase64: String
        public let issuer: String
        public init(secret: String, otpauthUrl: String, qrPngBase64: String, issuer: String) {
            self.secret = secret
            self.otpauthUrl = otpauthUrl
            self.qrPngBase64 = qrPngBase64
            self.issuer = issuer
        }
    }

    public struct EnrollmentResult: Equatable, Sendable {
        public let totpEnrolledAt: Int64
        public let recoveryCodes: [String]
        public init(totpEnrolledAt: Int64, recoveryCodes: [String]) {
            self.totpEnrolledAt = totpEnrolledAt
            self.recoveryCodes = recoveryCodes
        }
    }

    public private(set) var phase: Phase = .idle

    /// Current account-type badge state. Refreshed by `load()`. Pre-
    /// migration accounts (no row in /users/:u) surface as nil so the
    /// Settings screen can render a graceful placeholder.
    public private(set) var accountType: String?
    public private(set) var totpEnrolledAt: Int64?

    private let server: FlagshipServerClient
    private let username: @MainActor () -> String?

    public init(server: FlagshipServerClient, username: @MainActor @escaping () -> String?) {
        self.server = server
        self.username = username
    }

    /// Build the watch-delegate ("Quick approve from Apple Watch") toggle VM
    /// from the same server + username injection, so the Account-security
    /// screen can host the toggle without the app layer wiring a second
    /// dependency graph. Keystore-backed crypto/local-store use their
    /// defaults (this runs on a real device / the sim Keychain fallback).
    public func makeWatchDelegateViewModel() -> WatchDelegateViewModel {
        WatchDelegateViewModel(server: server, username: username)
    }

    /// Read the current account-type from the Worker. Idempotent;
    /// safe to call on every Settings screen open.
    public func load() async {
        guard let user = username(), !user.isEmpty else {
            accountType = nil
            totpEnrolledAt = nil
            return
        }
        do {
            let resp = try await server.getUsernameRecord(username: user)
            accountType = resp.accountType
            totpEnrolledAt = resp.totpEnrolledAt
        } catch {
            // Non-fatal — Settings still renders, just without the
            // badge until the next refresh.
            accountType = nil
            totpEnrolledAt = nil
        }
    }

    /// Convenience for the badge label/copy. Read-only; doesn't
    /// branch the UI past the displayed string.
    public var isMultiDevice: Bool { accountType == "multi" }

    /// Step 1→2: sign enroll-begin and ask the Worker to stage a
    /// secret. On success drops into `.staged`, which the sheet
    /// renders as the QR + manual-key + "I've added it" step.
    public func beginEnrollment() async {
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        phase = .beginning
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await Keystore.deriveIRK(
                reason: "Enable multi-device + 2FA",
                version: Keystore.currentIrkVersion()
            )
        } catch {
            phase = .failed("Couldn't access your account keys: \(error.localizedDescription)")
            return
        }
        let canonical = TotpEnrollBeginCanonical.bytes(username: user, issuedAt: issuedAt)
        let signature: Data
        do {
            signature = try irk.signature(for: canonical)
        } catch {
            phase = .failed("Couldn't sign enroll-begin: \(error.localizedDescription)")
            return
        }
        do {
            let resp = try await server.totpEnrollBegin(
                username: user,
                body: TotpEnrollBeginRequest(
                    request: .init(username: user, issuedAt: issuedAt),
                    signature: HexUtil.encode(signature)
                )
            )
            phase = .staged(StagedSecret(
                secret: resp.secret,
                otpauthUrl: resp.otpauthUrl,
                qrPngBase64: resp.qrPngBase64,
                issuer: resp.issuer
            ))
        } catch ScreensClientError.http(let status, _) where status == 503 {
            phase = .failed("Multi-device + 2FA isn't configured on this server yet. Try again later.")
        } catch {
            phase = .failed("Couldn't start enrollment: \(error.localizedDescription)")
        }
    }

    /// Step 3→4: submit the user-entered sample code; on success the
    /// account flips to `'multi'` and 10 recovery codes are returned
    /// once.
    public func confirmEnrollment(sampleCode: String) async {
        let trimmed = sampleCode.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            phase = .failed("Enter the 6-digit code from your authenticator app.")
            return
        }
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        // Keep the staged secret around so a sad-path retry can hop
        // back into .staged without re-deriving.
        let priorStaged: StagedSecret? = {
            if case .staged(let s) = phase { return s }
            return nil
        }()
        phase = .confirming

        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await Keystore.deriveIRK(
                reason: "Confirm 2FA code",
                version: Keystore.currentIrkVersion()
            )
        } catch {
            phase = .failed("Couldn't access your account keys: \(error.localizedDescription)")
            return
        }
        let canonical = TotpEnrollConfirmCanonical.bytes(username: user, issuedAt: issuedAt)
        let signature: Data
        do {
            signature = try irk.signature(for: canonical)
        } catch {
            phase = .failed("Couldn't sign enroll-confirm: \(error.localizedDescription)")
            return
        }
        do {
            let resp = try await server.totpEnrollConfirm(
                username: user,
                body: TotpEnrollConfirmRequest(
                    request: .init(username: user, issuedAt: issuedAt),
                    signature: HexUtil.encode(signature),
                    code: trimmed
                )
            )
            accountType = resp.accountType
            totpEnrolledAt = resp.totpEnrolledAt
            phase = .confirmed(EnrollmentResult(
                totpEnrolledAt: resp.totpEnrolledAt,
                recoveryCodes: resp.recoveryCodes
            ))
        } catch ScreensClientError.http(let status, _) where status == 401 {
            // Bounce back to .staged so the user can retry without
            // restarting the whole flow.
            if let staged = priorStaged {
                phase = .staged(staged)
            }
            // Surface the mismatch as a secondary failed state — the
            // UI re-reads `phase` and shows an inline error beside
            // the input.
            phase = .failed("That code didn't match. Try again with a fresh code from your authenticator.")
        } catch {
            phase = .failed("Couldn't confirm: \(error.localizedDescription)")
        }
    }

    /// User has saved the recovery codes; dismiss the sheet and
    /// scrub them from memory.
    public func dismissEnrollment() {
        phase = .idle
    }

    /// Disable a previously-enrolled 2FA. The user provides a live
    /// 6-digit code (or recovery code). Refused if other paired
    /// sessions exist (Worker enforces).
    public func disableEnrollment(code: String) async {
        let trimmed = code.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            phase = .failed("Enter your 6-digit code or a recovery code to confirm.")
            return
        }
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        phase = .disabling
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await Keystore.deriveIRK(
                reason: "Disable multi-device + 2FA",
                version: Keystore.currentIrkVersion()
            )
        } catch {
            phase = .failed("Couldn't access your account keys: \(error.localizedDescription)")
            return
        }
        let canonical = TotpDisableCanonical.bytes(username: user, issuedAt: issuedAt)
        let signature: Data
        do {
            signature = try irk.signature(for: canonical)
        } catch {
            phase = .failed("Couldn't sign disable: \(error.localizedDescription)")
            return
        }
        do {
            let resp = try await server.totpDisable(
                username: user,
                body: TotpDisableRequest(
                    request: .init(username: user, issuedAt: issuedAt),
                    signature: HexUtil.encode(signature),
                    code: trimmed
                )
            )
            accountType = resp.accountType
            totpEnrolledAt = nil
            phase = .disabled
        } catch ScreensClientError.http(let status, _) where status == 401 {
            phase = .failed("That code didn't match. Try a fresh code from your authenticator.")
        } catch ScreensClientError.http(let status, _) where status == 409 {
            phase = .failed("Disable refused — other devices are still trusted on this account. Disconnect them first.")
        } catch {
            phase = .failed("Couldn't disable: \(error.localizedDescription)")
        }
    }
}

#if canImport(CryptoKit)
import CryptoKit
#endif

/// Canonical-bytes helpers — mirror @flagship/protocol's
/// `canonicalTotpEnrollBegin` / `canonicalTotpEnrollConfirm` /
/// `canonicalTotpDisable`. Defined locally so the VM doesn't depend
/// on the JS-side protocol package (the iOS app already mirrors the
/// canonical-bytes everywhere else through these tiny helpers).
enum TotpEnrollBeginCanonical {
    static func bytes(username: String, issuedAt: Int64) -> Data {
        Data("flagship/totp-enroll-begin/v1|\(username)|\(issuedAt)".utf8)
    }
}
enum TotpEnrollConfirmCanonical {
    static func bytes(username: String, issuedAt: Int64) -> Data {
        Data("flagship/totp-enroll-confirm/v1|\(username)|\(issuedAt)".utf8)
    }
}
enum TotpDisableCanonical {
    static func bytes(username: String, issuedAt: Int64) -> Data {
        Data("flagship/totp-disable/v1|\(username)|\(issuedAt)".utf8)
    }
}
