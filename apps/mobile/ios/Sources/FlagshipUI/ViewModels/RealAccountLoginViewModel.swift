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
///       (single has no peer) → 3-day-grace explainer → install UMK →
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
        /// single → passkey-PRF takeover behind a 3-day grace.
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
        /// #52 — the cloud 401'd the single-device Phase-B initiate
        /// because the account has a second factor enrolled (TOTP /
        /// recovery code). The host shows the second-factor field
        /// (same UX as multi) and calls
        /// `submitSingleDeviceSecondFactor()`. `error` carries the
        /// rejection copy after a bad code so the user can retry in
        /// place.
        case needsSecondFactor(error: String?)
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

    /// Recovery rework Phase A — the recovery passphrase for the
    /// single-device gated unwrap. Bound to the passphrase field on the
    /// single branch; ignored on multi (which still runs the legacy
    /// passkey-only takeover pending the Phase-B rework).
    public var passphraseInput: String = ""

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
        case .singleTakeover:
            await startSingleDeviceRecovery()
        case .multiTakeover:
            await startMultiDeviceTakeover(ifMatch: ifMatch)
        }
    }

    /// Single-device recovery (recovery rework Phase A).
    ///
    /// A single-device account's recovered UMK *is* the account's key, so once
    /// we unwrap + install it this device already holds the registered
    /// identity — there is nothing to "take over" and no grace. We reuse the
    /// proven gated path (`RecoveryViewModel.recover`: passphrase → Argon2id →
    /// gated fetch → live passkey PRF → unwrap, plus the anti-coercion check +
    /// #28 ACME-key restore), install the seed, and finalize immediately.
    ///
    /// Phase B handles the rotated-account case — where the recovered key no
    /// longer matches the server's current registered IRK — by detecting the
    /// mismatch and running a real re-pair (3-day grace) against the live key.
    private func startSingleDeviceRecovery() async {
        guard passphraseInput.count >= 8 else {
            phase = .failed("Enter your recovery passphrase (at least 8 characters).")
            return
        }
        phase = .working
        let username = resolution.username

        // Gated unwrap of the cloud UMK against the LIVE passkey provider the
        // screen injects. `recover` owns the Argon2id derivation, the gated
        // `/fetch`, the prfSalt anti-coercion guard, and the ACME-key unwrap.
        // It ALSO captures `registeredIrkPubHex` (the account's currently
        // registered IRK) from the fetch — the load-bearing signal for the
        // Phase-A vs Phase-B decision below.
        let recoveryVM = RecoveryViewModel(client: server, webAuthn: webAuthn)
        guard let seed = await recoveryVM.recover(username: username, passphrase: passphraseInput) else {
            if Task.isCancelled { return }
            if case .failed(let msg) = recoveryVM.phase {
                phase = .failed(humanizedRecoveryMessage(msg))
            } else {
                phase = .failed("Recovery was cancelled.")
            }
            return
        }

        // Install into THIS account's slot. installUMK resets the IRK lineage
        // to v1 under the recovered UMK — which, for an unchanged account, is
        // exactly the IRK the server still has registered.
        Keystore.setActiveProfile(username)
        do {
            try await installUMK(seed, "Bring this device into your Flagship account")
        } catch {
            phase = .failed("Couldn't install your recovered account key: \(error.localizedDescription)")
            return
        }

        // Task #29 / Recovery Phase A vs B — the decision the whole
        // sign-out → recover → instant-repair round-trip rests on. Derive
        // the IRK from the JUST-installed (recovered) UMK and compare it to
        // the account's currently registered IRK:
        //
        //   • match (or no registered value from a pre-Phase-B Worker) ⇒
        //     PHASE A. The recovered key IS the registered identity, so this
        //     device already holds it — pair immediately, no grace, no
        //     rotation. This is exactly what makes a Tier-2 SIGN OUT (key
        //     wiped, server untouched) come back cleanly: same key restored,
        //     instant re-pair.
        //
        //   • mismatch ⇒ PHASE B. The registered key rotated since the
        //     recovery envelope was written (e.g. another device ran Replace
        //     / Wipe). The recovered key is stale, so we must run a real
        //     re-pair against the LIVE key — signing the initiate with the
        //     recovered IRK but carrying `oldIrkPub = registeredIrkPubHex` so
        //     the Worker keys the takeover on the displaced key — and wait
        //     out the grace window (.completed → countdown → completeTakeover).
        let recoveredIrkPubHex: String
        do {
            let irk = try await Keystore.deriveIRK(reason: "Verify recovered account key")
            recoveredIrkPubHex = HexUtil.encode(irk.publicKey.rawRepresentation)
        } catch {
            phase = .failed("Couldn't verify your recovered account key: \(error.localizedDescription)")
            return
        }

        if recoveryVM.recoveredKeyMatchesRegistered(recoveredIrkPubHex: recoveredIrkPubHex) {
            // Phase A — instant pair.
            phase = .finalized(username: username)
            return
        }

        // Phase B — the registered key rotated; re-pair against it with grace.
        do {
            let resp = try await initiateRotatedRePair(
                username: username,
                oldIrkPubHex: recoveryVM.registeredIrkPubHex ?? recoveredIrkPubHex
            )
            phase = .completed(username: username, completesAt: resp.completesAt)
        } catch ScreensClientError.http(let status, _) where status == 401 {
            // #52 — we sent NO proof, so a 401 here is the cloud saying
            // "this account has a second factor enrolled; prove it".
            // Stash the initiate inputs and surface the second-factor
            // field (same UX the multi branch uses); the retry runs in
            // submitSingleDeviceSecondFactor().
            pendingRotatedRePair = (username: username,
                                    oldIrkPubHex: recoveryVM.registeredIrkPubHex ?? recoveredIrkPubHex)
            phase = .needsSecondFactor(error: nil)
        } catch {
            phase = .failed("Couldn't restore access: \(error.localizedDescription)")
        }
    }

    /// #52 — stashed inputs for the single-device Phase-B initiate so
    /// the second-factor retry doesn't have to re-run the recovery
    /// unwrap (the UMK is already installed at this point).
    private var pendingRotatedRePair: (username: String, oldIrkPubHex: String)?

    /// #52 — retry the single-device Phase-B initiate with the typed
    /// second factor (TOTP or recovery code) riding the body. Driven by
    /// the host once `.needsSecondFactor` is showing and
    /// `secondFactorInput` is non-empty. A rejected code lands back on
    /// `.needsSecondFactor(error:)` so the user can correct in place.
    public func submitSingleDeviceSecondFactor() async {
        guard let pending = pendingRotatedRePair else { return }
        let code = secondFactorInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else {
            phase = .needsSecondFactor(error: "Enter your recovery code or the 6-digit code from your authenticator app.")
            return
        }
        phase = .working
        do {
            let resp = try await initiateRotatedRePair(
                username: pending.username,
                oldIrkPubHex: pending.oldIrkPubHex,
                proof: RePairInitiateRequest.TotpProof(
                    code: code,
                    method: Self.proofMethod(for: code)
                )
            )
            pendingRotatedRePair = nil
            phase = .completed(username: pending.username, completesAt: resp.completesAt)
        } catch ScreensClientError.http(let status, _) where status == 401 {
            phase = .needsSecondFactor(error: "That recovery code or authenticator code wasn't accepted. Check it and try again.")
        } catch {
            phase = .failed("Couldn't restore access: \(error.localizedDescription)")
        }
    }

    /// Phase B re-pair initiate for the single-device rotated case. Signs
    /// with the recovered (new) IRK over the canonical bytes, but carries
    /// the account's registered (displaced) IRK as `oldIrkPub` so the
    /// Worker keys the takeover on the key it currently knows. `proof`
    /// (#52) rides BESIDE the signed envelope when the cloud demanded a
    /// second factor; nil on the first, bare attempt.
    private func initiateRotatedRePair(
        username: String,
        oldIrkPubHex: String,
        proof: RePairInitiateRequest.TotpProof? = nil
    ) async throws -> RePairInitiateResponse {
        let newKey = try await Keystore.deriveIRK(reason: "Authorize takeover")
        let newPubHex = HexUtil.encode(newKey.publicKey.rawRepresentation)
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let canonical = RePairInitiate.canonicalBytes(
            username: username,
            newIrkPubHex: newPubHex,
            oldIrkPubHex: oldIrkPubHex,
            issuedAt: issuedAt
        )
        let signature = try newKey.signature(for: canonical)
        return try await server.initiateRePair(
            username: username,
            body: RePairInitiateRequest(
                request: .init(
                    username: username,
                    newIrkPub: newPubHex,
                    oldIrkPub: oldIrkPubHex,
                    issuedAt: issuedAt
                ),
                signature: HexUtil.encode(signature),
                totpProof: proof
            ),
            ifMatch: nil
        )
    }

    /// Multi-device takeover (legacy path, pending the Phase-B rework). Still
    /// runs the passkey-only unwrap + re-pair with a TOTP / recovery-code
    /// second factor. Unchanged by Phase A, which scopes the gated-unwrap
    /// rework to single-device accounts first.
    private func startMultiDeviceTakeover(ifMatch: String?) async {
        guard canStartMultiTakeover else {
            phase = .failed("Enter your recovery code or the 6-digit code from your authenticator app.")
            return
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

        // 2 — Install the recovered UMK into this account's slot.
        Keystore.setActiveProfile(username)
        do {
            try await installUMK(seed, "Bring this device into your Flagship account")
        } catch {
            phase = .failed("Couldn't install your recovered account key: \(error.localizedDescription)")
            return
        }

        // 3 — Initiate the takeover re-pair with the typed second factor.
        do {
            let resp = try await initiateTakeoverRePair(
                username: username,
                ifMatch: ifMatch
            )
            phase = .completed(username: username, completesAt: resp.completesAt)
        } catch ScreensClientError.http(let status, _) where status == 401 {
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
        } catch ScreensClientError.http(let status, _) where status == 410 {
            // #52 — the completion window (7d past the grace deadline)
            // elapsed; the cloud swept the stale row. Unlike 404 this
            // is NOT "already done" — the recovery must be restarted.
            phase = .failed("This recovery expired before it was completed. Start again.")
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

    /// String-form humanizer for the single-device path, where the failure
    /// arrives as `RecoveryViewModel`'s phase message rather than a thrown
    /// Error. Maps the common cases (cancelled sheet, wrong passphrase, missing
    /// passkey) to friendly copy; otherwise passes the message through.
    private func humanizedRecoveryMessage(_ raw: String) -> String {
        let lower = raw.lowercased()
        if lower.contains("cancel") || lower.contains("1001") {
            return "Passkey sign-in was cancelled. Tap Restore access to try again, or use Import backup file below."
        }
        if lower.contains("invalid fetch token") || lower.contains("wrong passphrase")
            || lower.contains("403") {
            return "That passphrase didn't match. Check it and try again."
        }
        if lower.contains("not allowed") || lower.contains("no credentials")
            || lower.contains("nomatchingcredential") || lower.contains("interrupted")
            || lower.contains("no envelope") || lower.contains("404") {
            return "We couldn't find your recovery passkey on this device. Make sure you're signed in to the same iCloud account with iCloud Keychain on, or use Import backup file below."
        }
        return raw
    }
}
