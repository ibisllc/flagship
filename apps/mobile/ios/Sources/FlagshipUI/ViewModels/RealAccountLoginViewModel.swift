import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Phase 3 — the real single/multi **login state machine**.
///
/// Phase 1's `LoginViewModel` is the username-first preflight router: it
/// runs `/api/account/resolve` (200 always) and lands on `.realAccount`
/// for `kind == single | multi`. This view model takes that resolution
/// and drives the credentialed-takeover branches that Phase 1 stubbed
/// out to the old `RecoverFromWelcomeContainer`.
///
/// Mock-only (per the Phase 3 scope): the WebAuthn-PRF unwrap runs
/// against `MockWebAuthnProvider`; live `ASAuthorization` wrappers are a
/// separate human/device task. Everything else — install the recovered
/// UMK, initiate the re-pair, label this device `admin`, complete
/// onboarding — is the real path.
///
/// Branching (driven entirely off `AccountResolution`, never re-derived):
///   - `recovery.present == false` → a clean STATE (no crash, no 404):
///       single → "No cloud backup on this account. Use a device that
///                 still has access."
///       multi  → "Use another device, or one of your recovery codes."
///   - `single` + recovery → passkey-PRF unwrap → this is a TAKEOVER
///       (single has no peer) → 7-day-grace explainer → install UMK →
///       initiate re-pair → label `admin` → completeOnboarding.
///   - `multi` + recovery + totpEnrolled → passkey-PRF unwrap AND a
///       recovery TOTP (6-digit) OR a recovery code → pass it as the
///       re-pair `totpProof` → 24h-grace takeover → install UMK → admin.
///
/// See docs/login-and-account-redesign.md "The unified login decision
/// tree" + "The admin label & the no-lockout guarantee".
@MainActor
@Observable
public final class RealAccountLoginViewModel {

    /// The takeover that a credential-proven login produces. Stable id
    /// stays `ukey.dkey`; the `admin` label is the *reach* primitive
    /// (`ukey.*`) the no-lockout guarantee depends on. We carry it as
    /// the local device label so this device records itself as admin.
    public static let adminDeviceLabel = "admin"

    /// What the host should render for this resolution. Computed from
    /// the preflight ONCE so the view doesn't re-derive the matrix.
    public enum Branch: Equatable, Sendable {
        /// No cloud backup on the account (recovery.present == false).
        /// `multi` differs only in copy (recovery-codes hint).
        case noRecovery(multi: Bool)
        /// single → passkey-PRF takeover behind a 7-day grace.
        case singleTakeover
        /// multi → passkey-PRF + a recovery TOTP / recovery-code behind
        /// a 24h grace. `totpEnrolled` is always true here (the
        /// `multi ⇒ totpEnrolled` invariant), surfaced so the UI copy
        /// can mention the authenticator app.
        case multiTakeover
    }

    public enum Phase: Equatable, Sendable {
        /// Showing the branch's pre-flight explainer (grace copy /
        /// no-recovery state / the multi second-factor field).
        case idle
        /// The takeover ceremony is running (PRF unwrap → install →
        /// re-pair). Drives a spinner; the user can't re-tap.
        case working
        /// Re-pair INITIATED — the grace clock is running server-side.
        /// Carries the deadline so the Phase-4 screen renders a countdown
        /// + "Take over now". (Phase 3 paired here; Phase 4 pairs on
        /// `.finalized`, after the COMPLETE lands.)
        case completed(username: String, completesAt: Int64)
        /// Phase 4 — the re-pair COMPLETE landed (grace elapsed); the
        /// takeover is final. The host flips AppState to paired on this.
        case finalized(username: String)
        /// A recoverable failure (PRF cancelled, transport, bad TOTP).
        /// The view re-shows the explainer + the message.
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    /// For `multiTakeover` — the recovery TOTP (6 digits) or a recovery
    /// code the user types before the takeover can initiate. Bound to
    /// the second-factor field; ignored on the single branch.
    public var secondFactorInput: String = ""

    public let resolution: AccountResolution
    public let branch: Branch

    private let server: any FlagshipServerClient
    private let webAuthn: WebAuthnProvider
    /// Seam so tests can assert the recovered UMK is actually installed
    /// without piercing the Secure Enclave. Defaults to the real
    /// `Keystore.installUMK`, retiring the old `completeRecoveryPair`
    /// stub that left the seed on the floor.
    private let installUMK: @MainActor (SymmetricKey, String) async throws -> Void

    public init(
        resolution: AccountResolution,
        server: any FlagshipServerClient,
        webAuthn: WebAuthnProvider = MockWebAuthnProvider(),
        installUMK: @escaping @MainActor (SymmetricKey, String) async throws -> Void = { seed, reason in
            try await Keystore.installUMK(seed, reason: reason)
        }
    ) {
        self.resolution = resolution
        self.server = server
        self.webAuthn = webAuthn
        self.installUMK = installUMK
        self.branch = Self.deriveBranch(resolution)
    }

    /// Pure derivation of the render branch from the preflight. Every
    /// "absent" is a node here, never an error. `multi` short-circuits
    /// to `.noRecovery(multi: true)` when there's no cloud backup so
    /// the user gets the recovery-codes hint copy.
    public static func deriveBranch(_ r: AccountResolution) -> Branch {
        if !r.recovery.present {
            return .noRecovery(multi: r.kind == .multi)
        }
        switch r.kind {
        case .multi:  return .multiTakeover
        case .single: return .singleTakeover
        // demo / unknown never reach this VM (LoginViewModel routes
        // them elsewhere); treat defensively as single-takeover-shaped.
        case .demo, .unknown: return .singleTakeover
        }
    }

    /// True once the user has typed enough to attempt a multi takeover.
    /// A 6-digit TOTP or a recovery code (we don't over-validate the
    /// shape here — the Worker is authoritative; we only block empty).
    public var canStartMultiTakeover: Bool {
        !secondFactorInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Whether the typed second factor looks like a 6-digit TOTP (all
    /// digits, length 6). Anything else is treated as a recovery code.
    /// Mirrors the Worker's `method` discriminator selection.
    static func proofMethod(for raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let isSixDigits = trimmed.count == 6 && trimmed.allSatisfy(\.isNumber)
        return isSixDigits ? "totp" : "recovery"
    }

    /// Run the credentialed takeover for the resolved account. Mock
    /// WebAuthn-PRF unwraps the cloud UMK; we install it, initiate the
    /// re-pair (multi attaches the `totpProof`), and complete. Lands on
    /// `.completed` (host flips AppState) or `.failed` (recoverable).
    ///
    /// `ifMatch` is the ETag from a fresh `listDevices` if the host has
    /// one; nil is tolerated (single has no peer device to fence
    /// against, and the takeover overrides any device-set lock anyway).
    public func startTakeover(ifMatch: String? = nil) async {
        switch branch {
        case .noRecovery:
            // Nothing to do — the host renders the state; there's no
            // ceremony to run.
            return
        case .multiTakeover:
            guard canStartMultiTakeover else {
                phase = .failed("Enter your recovery code or the 6-digit code from your authenticator app.")
                return
            }
        case .singleTakeover:
            break
        }

        phase = .working
        let username = resolution.username

        // 1 — WebAuthn-PRF unwrap of the cloud-stored UMK (Mock).
        let seed: SymmetricKey
        do {
            let prompt = try await webAuthn.assertAny()
            let env = try await server.fetchRecoveryEnvelope(credentialId: prompt.credentialId)
            let prfSecret = try await webAuthn.prfAssert(credentialId: prompt.credentialId)
            seed = try Recovery.unwrap(
                wrappedUmkBase64: env.wrappedUmk,
                prfSecret: prfSecret
            )
        } catch {
            if Task.isCancelled { return }
            phase = .failed(humanizedRecoveryError(error))
            return
        }

        // 2 — Install the recovered UMK. This is the step the old
        // `completeRecoveryPair` stubbed out; with it in place the
        // derived IRK/BAK/SWK match the recovered identity. Reset to
        // v1 (installUMK does this) — a takeover starts a fresh IRK
        // lineage under the recovered UMK.
        //
        // Per-profile keying: point the keystore at THIS account's slot
        // before installing so a takeover of a second cloud lands in its
        // own slot and never clobbers an already-present profile. The
        // injected `installUMK` seam (default = Keystore.installUMK)
        // writes to whatever slot is active.
        Keystore.setActiveProfile(username)
        do {
            try await installUMK(seed, "Bring this device into your Flagship account")
        } catch {
            phase = .failed("Couldn't install your recovered account key: \(error.localizedDescription)")
            return
        }

        // 3 — Initiate the re-pair (TAKEOVER). The new IRK derives from
        // the just-installed UMK at the current (reset) version; the
        // old IRK is the same derivation pre-install isn't available on
        // a fresh device, so we sign with the new key over both pubkeys
        // (the Worker's takeover path tolerates a new==old-shaped
        // initiate; the grace + admin reach are what matter here).
        do {
            let resp = try await initiateTakeoverRePair(
                username: username,
                ifMatch: ifMatch
            )
            phase = .completed(username: username, completesAt: resp.completesAt)
        } catch ScreensClientError.http(let status, _) where status == 401 {
            // Multi only — the Worker rejected the second factor.
            phase = .failed("That recovery code or authenticator code wasn't accepted. Check it and try again.")
        } catch {
            phase = .failed("Couldn't restore access: \(error.localizedDescription)")
        }
    }

    /// Phase 4 — finalize the takeover once its grace has elapsed. The
    /// re-pair COMPLETE endpoint is a public, idempotent CAS-swap with no
    /// signature gate, so we POST an empty body via `completeRePair`. 404
    /// == already swapped/swept (treat as success); 425 == too early
    /// (stay in grace); 403/409 == objected (cancelled).
    public func completeTakeover() async {
        guard case .completed(let username, let completesAt) = phase else { return }
        phase = .working
        do {
            _ = try await server.completeRePair(username: username)
            phase = .finalized(username: username)
        } catch ScreensClientError.http(let status, _) where status == 404 {
            phase = .finalized(username: username)
        } catch ScreensClientError.http(let status, _) where status == 425 {
            phase = .completed(username: username, completesAt: completesAt)
        } catch ScreensClientError.http(let status, _) where status == 403 || status == 409 {
            phase = .failed("This was cancelled from another device on your account. If it's still you, start again.")
        } catch {
            phase = .failed("Couldn't finalize the takeover: \(error.localizedDescription)")
        }
    }

    /// Build + POST the re-pair initiate. Multi attaches the typed
    /// second factor as `totpProof`; single omits it. Signed by the
    /// new IRK over the canonical bytes (totpProof stays OUT of the
    /// signed envelope — codes are ephemeral).
    private func initiateTakeoverRePair(
        username: String,
        ifMatch: String?
    ) async throws -> RePairInitiateResponse {
        let newKey = try await Keystore.deriveIRK(reason: "Authorize takeover")
        let newPubHex = HexUtil.encode(newKey.publicKey.rawRepresentation)
        // On a fresh takeover device we don't hold the displaced key's
        // private half; the old pubkey slot carries the new pubkey so
        // the canonical bytes are well-formed. The Worker keys the
        // takeover on the username row, not on a client-asserted old
        // pubkey.
        let oldPubHex = newPubHex
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let canonical = RePairInitiate.canonicalBytes(
            username: username,
            newIrkPubHex: newPubHex,
            oldIrkPubHex: oldPubHex,
            issuedAt: issuedAt
        )
        let signature = try newKey.signature(for: canonical)

        var proof: RePairInitiateRequest.TotpProof?
        if branch == .multiTakeover {
            let code = secondFactorInput.trimmingCharacters(in: .whitespacesAndNewlines)
            proof = RePairInitiateRequest.TotpProof(
                code: code,
                method: Self.proofMethod(for: code)
            )
        }

        return try await server.initiateRePair(
            username: username,
            body: RePairInitiateRequest(
                request: .init(
                    username: username,
                    newIrkPub: newPubHex,
                    oldIrkPub: oldPubHex,
                    issuedAt: issuedAt
                ),
                signature: HexUtil.encode(signature),
                totpProof: proof
            ),
            ifMatch: ifMatch
        )
    }

    /// Reset to the explainer so the user can retry after a failure.
    public func reset() {
        phase = .idle
    }

    private func humanizedRecoveryError(_ error: Error) -> String {
        let lower = "\(error)".lowercased()
        // User dismissed the system passkey sheet (ASAuthorizationError.canceled
        // is code 1001). Don't claim their passkey is missing — it isn't.
        if lower.contains("cancel") || lower.contains("1001") {
            return "Passkey sign-in was cancelled. Tap Restore access to try again, or use Import backup file below."
        }
        if lower.contains("not allowed") || lower.contains("no credentials")
            || lower.contains("nomatchingcredential") || lower.contains("interrupted")
            || lower.contains("no envelope") || lower.contains("404")
        {
            return "We couldn't find your recovery passkey on this device. Make sure you're signed in to the same iCloud account with iCloud Keychain turned on. If you have your backup key file, use Import backup file below instead."
        }
        return "Recovery failed: \(error.localizedDescription)"
    }
}
