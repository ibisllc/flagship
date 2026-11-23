import Foundation
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// v1.2 Phase 4 — drives Settings → Account security → Code protection:
///
///   1. Load the account-type badge state from
///      `GET /api/users/:u` (single vs multi-device).
///   2. Step the user through the four-step enroll sheet (explainer
///      → QR + secret → sample code → recovery codes).
///   3. Optionally disable an existing enrollment (Phase 3 endpoint;
///      gated by the Worker on single-device-count).
///
/// Turning code protection on or off is an admin order (owner, 2026-11-23;
/// security report F2): enroll-begin / enroll-confirm / disable are signed
/// with the admin root (`Keystore.sensitiveOrderSigningKey`, the IRK only on
/// an account with no admin root), `.com` refuses anything else with
/// `totp-admin-only`, and a device that isn't an admin sees the setting
/// read-only (`canChange`). `.com`'s refusals carry a `code`, which
/// `CodeProtectionText` turns into a sentence.
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
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// Whether this device may turn code protection on or off: an admin
    /// device (or a demo account's), `AdminOrderGate.allows`.
    public let canChange: @MainActor () -> Bool

    public init(
        server: FlagshipServerClient,
        username: @MainActor @escaping () -> String?,
        canChange: @MainActor @escaping () -> Bool = { Keystore.hasAdminRoot },
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil
    ) {
        self.server = server
        self.username = username
        self.canChange = canChange
        self.signer = signer ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
    }

    /// Build the watch-delegate ("Approve from watch") toggle VM
    /// from the same server + username injection, so the Account-security
    /// screen can host the toggle without the app layer wiring a second
    /// dependency graph. Keystore-backed crypto/local-store use their
    /// defaults (this runs on a real device / the sim Keychain fallback).
    public func makeWatchDelegateViewModel(mailbox: SecretMailboxClient? = nil) -> WatchDelegateViewModel {
        WatchDelegateViewModel(server: server, username: username, mailbox: mailbox)
    }

    /// Slice D §5 — build the "Rotate admin key" VM off the same server +
    /// username injection. Keystore-backed crypto uses its defaults, and the
    /// post-rotation recovery re-escrow seams take their production defaults
    /// too (`server.hasCloudRecovery` + `AdminRootReEscrow` over the platform
    /// WebAuthn provider). Only a device holding the admin master root can
    /// actually rotate (`canRotate`).
    public func makeRotateAdminRootViewModel() -> RotateAdminRootViewModel {
        RotateAdminRootViewModel(server: server, username: username)
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
            phase = .failed(String(localized: "No active account on this device."))
            return
        }
        guard canChange() else {
            phase = .failed(CodeProtectionText.adminOnly)
            return
        }
        phase = .beginning
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await signer(String(localized: "Turn on code protection"))
        } catch {
            phase = .failed(String(localized: "Couldn't access your account keys: \(UserErrorText.of(error))"))
            return
        }
        let canonical = TotpEnrollBeginCanonical.bytes(username: user, issuedAt: issuedAt)
        let signature: Data
        do {
            signature = try irk.signature(for: canonical)
        } catch {
            phase = .failed(String(localized: "Couldn't sign enroll-begin: \(UserErrorText.of(error))"))
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
        } catch {
            if let sentence = CodeProtectionText.refusal(error) {
                phase = .failed(sentence)
                if CodeProtectionText.code(of: error) == "totp-already-enrolled" { await load() }
            } else {
                phase = .failed(String(localized: "Couldn't start enrollment: \(UserErrorText.of(error))"))
            }
        }
    }

    /// Step 3→4: submit the user-entered sample code; on success the
    /// account flips to `'multi'` and 10 recovery codes are returned
    /// once.
    public func confirmEnrollment(sampleCode: String) async {
        let trimmed = sampleCode.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            phase = .failed(String(localized: "Enter the 6-digit code from your authenticator app."))
            return
        }
        guard let user = username(), !user.isEmpty else {
            phase = .failed(String(localized: "No active account on this device."))
            return
        }
        // Keep the staged secret around so a sad-path retry can hop
        // back into .staged without re-deriving.
        let priorStaged: StagedSecret? = {
            if case .staged(let s) = phase { return s }
            return nil
        }()
        guard canChange() else {
            phase = .failed(CodeProtectionText.adminOnly)
            return
        }
        phase = .confirming

        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await signer(String(localized: "Confirm your code"))
        } catch {
            phase = .failed(String(localized: "Couldn't access your account keys: \(UserErrorText.of(error))"))
            return
        }
        let canonical = TotpEnrollConfirmCanonical.bytes(username: user, issuedAt: issuedAt)
        let signature: Data
        do {
            signature = try irk.signature(for: canonical)
        } catch {
            phase = .failed(String(localized: "Couldn't sign enroll-confirm: \(UserErrorText.of(error))"))
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
        } catch ScreensClientError.http(let status, let body)
            where status == 401 && (CodeProtectionText.code(body) ?? "invalid-totp-code") == "invalid-totp-code" {
            // Bounce back to .staged so the user can retry without
            // restarting the whole flow.
            if let staged = priorStaged {
                phase = .staged(staged)
            }
            // Surface the mismatch as a secondary failed state — the
            // UI re-reads `phase` and shows an inline error beside
            // the input.
            phase = .failed(String(localized: "That code didn't match. Try again with a fresh code from your authenticator."))
        } catch {
            if let sentence = CodeProtectionText.refusal(error) {
                phase = .failed(sentence)
                if CodeProtectionText.code(of: error) == "totp-already-enrolled" { await load() }
            } else {
                phase = .failed(String(localized: "Couldn't confirm: \(UserErrorText.of(error))"))
            }
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
            phase = .failed(String(localized: "Enter your 6-digit code or a recovery code to confirm."))
            return
        }
        guard let user = username(), !user.isEmpty else {
            phase = .failed(String(localized: "No active account on this device."))
            return
        }
        guard canChange() else {
            phase = .failed(CodeProtectionText.adminOnly)
            return
        }
        phase = .disabling
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await signer(String(localized: "Turn off code protection"))
        } catch {
            phase = .failed(String(localized: "Couldn't access your account keys: \(UserErrorText.of(error))"))
            return
        }
        let canonical = TotpDisableCanonical.bytes(username: user, issuedAt: issuedAt)
        let signature: Data
        do {
            signature = try irk.signature(for: canonical)
        } catch {
            phase = .failed(String(localized: "Couldn't sign disable: \(UserErrorText.of(error))"))
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
        } catch {
            if let sentence = CodeProtectionText.refusal(error) {
                phase = .failed(sentence)
                if CodeProtectionText.code(of: error) == "totp-not-enrolled" {
                    accountType = "single"
                    totpEnrolledAt = nil
                }
            } else if case ScreensClientError.http(409, _) = error {
                phase = .failed(CodeProtectionText.otherDevices)
            } else {
                phase = .failed(String(localized: "Couldn't disable: \(UserErrorText.of(error))"))
            }
        }
    }
}

#if canImport(CryptoKit)
import CryptoKit
#endif

/// `.com`'s code protection refusals (packages/control-plane/src/totp.ts
/// `TotpRefusalCode`) as sentences. Mirrors the webapp's lib/totp.js
/// `totpRefusalText` and Android's `CodeProtectionText`.
public enum CodeProtectionText {
    public static let adminOnly = String(localized: "Only an admin device of this account can change code protection.")
    public static let alreadyOn = String(localized: "Code protection is already on for this account. Turn it off first to set up a new authenticator.")
    public static let alreadyOff = String(localized: "Code protection is already off for this account.")
    public static let notAvailable = String(localized: "Code protection isn't available on this server yet. Try again later.")
    public static let expired = String(localized: "This setup expired. Start again to get a new key.")
    public static let wrongCode = String(localized: "That code didn't match. Try a fresh code from your authenticator.")
    public static let otherDevices = String(localized: "Disable refused — other devices are still trusted on this account. Disconnect them first.")
    public static let accountNotFound = String(localized: "Flagship couldn't find this account.")

    /// The `code` of a refusal body, if it has one.
    public static func code(_ body: String) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any] else { return nil }
        return obj["code"] as? String
    }

    public static func code(of error: Error) -> String? {
        guard case ScreensClientError.http(_, let body) = error else { return nil }
        return code(body)
    }

    /// The sentence for one of `.com`'s refusals, or nil when the error is
    /// something else (transport, decoding), which `UserErrorText` words.
    public static func refusal(_ error: Error) -> String? {
        guard case ScreensClientError.http(let status, let body) = error else { return nil }
        if let r = RateLimitedRefusal.from(status: status, body: body) { return r.message }
        switch code(body) {
        case "totp-admin-only": return adminOnly
        case "totp-already-enrolled": return alreadyOn
        case "totp-not-enrolled": return alreadyOff
        case "totp-not-configured": return notAvailable
        case "totp-pending-expired", "totp-no-pending": return expired
        case "invalid-totp-code": return wrongCode
        case "totp-other-devices": return otherDevices
        case "account-not-found": return accountNotFound
        case "internal-error": return UserErrorText.serverProblem
        default: break
        }
        if status == 503 { return notAvailable }
        if status == 401 { return wrongCode }
        return nil
    }
}

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
