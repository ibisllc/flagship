// Phase 3 (login redesign) — REAL single/multi login state machine.
//
// The sign-in space is access-control EVALUATION, not a fetch. Phase 1's
// JoinAccountContainer resolves a bare username (GET /api/account/
// resolve/<u>, 200 ALWAYS) and, for `kind == single | multi`, handed off
// to the legacy WebAuthn-PRF recovery container (a stopgap that paired
// with `username = "recovered-user"` and never installed the recovered
// UMK). This view model replaces that stub with the real decision tree
// driven entirely off the preflight [AccountResolution].
//
// Branches (mirror of docs/login-and-account-redesign.md "The unified
// login decision tree"):
//
//   recovery.present == false  → a STATE, not an error:
//       single → "No cloud backup on this account. Use a device that
//                 still has access."
//       multi  → "Use another device, or one of your recovery codes."
//
//   single (recovery.present)  → passkey-PRF unwrap (Mock) → TAKEOVER:
//       3-day-grace explainer → on confirm: installUmk(seed),
//       INITIATE re-pair (POST /api/users/:u/re-pair), label this
//       device "admin", complete onboarding with the RESOLVED username
//       (no "recovered-user" placeholder) + empty pods.
//
//   multi (recovery.present, totpEnrolled) → passkey-PRF unwrap (Mock)
//       AND collect a recovery TOTP (6-digit) OR a single-use recovery
//       code → pass it as the re-pair `totpProof` (the Worker REQUIRES
//       it for account_type == multi) → 24h-grace TAKEOVER → installUmk
//       + admin label, same as single but with the second factor.
//
// OUT OF SCOPE (Phase 4): grace countdown / completion polling / push /
// quarantine. This VM only INITIATES the re-pair (the grace clock starts
// server-side); completion is Phase 4. Live WebAuthn (CredentialManager)
// is a separate human/device task — Mock only here.
//
// Mirror of the iOS Phase 3 LoginViewModel single/multi branches.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.AccountResolution
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.RePairInitiateRequest
import com.flagshipserver.app.core.AcmeAccountKey
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.core.RePairInitiateClaim
import com.flagshipserver.app.keystore.CloudRecoveryEnrollment
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.Recovery
import com.flagshipserver.app.keystore.WebAuthnProvider
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/** The label every credential-proven takeover stamps on its new device.
 *  Reach (`ukey.*`) is what makes it special, not the id — but the label
 *  is the user-visible marker of the no-lockout guarantee. See
 *  docs/login-and-account-redesign.md "The admin label". */
const val ADMIN_DEVICE_LABEL = "admin"

/** The login state machine's terminal + transient phases. The single
 *  and multi branches share most states; the difference is the gate
 *  before [TakeoverReady] (multi needs the second factor first) and the
 *  grace copy ([graceModel]). */
sealed interface LoginPhase {
    /** Nothing started yet — the host hasn't called [begin]. */
    data object Idle : LoginPhase

    /** recovery.present == false. A clean STATE (never a 404). The copy
     *  differs by account kind; the host renders it from [single]. */
    data class NoCloudBackup(val single: Boolean) : LoginPhase

    /** The account's cloud record is gated by a recovery passphrase
     *  (recovery.hasFetchGate == true). The host collects the passphrase
     *  and calls [submitPassphrase]; the Argon2id-derived fetchToken then
     *  gates the .com ciphertext release. [single] drives the copy. */
    data class AwaitingPassphrase(val single: Boolean) : LoginPhase

    /** The PRF assertion + unwrap is running. */
    data object Recovering : LoginPhase

    /** MULTI only — the passkey unwrapped, but the Worker requires a
     *  recovery TOTP (or recovery code) before it will mutate the
     *  device key. The host collects a 6-digit code or a recovery code
     *  and calls [submitSecondFactor]. */
    data object AwaitingSecondFactor : LoginPhase

    /** The recovered UMK is in hand (single: straight after unwrap;
     *  multi: after the second factor was accepted). The host shows the
     *  grace explainer; on confirm it calls [confirmTakeover]. */
    data class TakeoverReady(val graceModel: AccountResolution.GraceModel) : LoginPhase

    /** Phase 4 — re-pair INITIATED; the grace clock is running server-
     *  side. Carries the deadline so the host renders a countdown +
     *  "Take over now". Pairing happens on completion, not here. */
    data class Grace(
        val completesAt: Long,
        val graceModel: AccountResolution.GraceModel,
    ) : LoginPhase

    /** confirmTakeover() / completeTakeover() is running. */
    data object TakingOver : LoginPhase

    /** Done — the account is open as a fresh `admin` device. */
    data object Opened : LoginPhase

    /** A real failure (not a missing factor — those are STATES). */
    data class Failed(val message: String) : LoginPhase
}

/**
 * Drives the real single/multi login state machine off a resolved
 * [AccountResolution]. Construct once per join attempt with the
 * preflight; the host calls [begin], then (multi) [submitSecondFactor],
 * then [confirmTakeover].
 *
 * The recovered seed lives only in this VM's memory between unwrap and
 * the confirmed takeover; it is installed via [Keystore.installUmk]
 * exactly once, inside [confirmTakeover], so a user who backs out of the
 * grace explainer never overwrites their local crypto state.
 */
class LoginViewModel(
    private val resolution: AccountResolution,
    private val server: FlagshipServerClient,
    private val app: AppState,
    private val webauthn: WebAuthnProvider,
    /** Wall-clock injectable for deterministic canonical-bytes tests. */
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    private val _phase = MutableStateFlow<LoginPhase>(LoginPhase.Idle)
    val phase: StateFlow<LoginPhase> = _phase.asStateFlow()

    /** The resolved handle — drives the admin label + completeOnboarding,
     *  killing the legacy "recovered-user" placeholder. */
    val username: String get() = resolution.username

    private val isMulti: Boolean get() = resolution.accountKind == AccountResolution.AccountKind.Multi

    /** Recovered UMK seed, held in memory between unwrap and the
     *  confirmed takeover. Never persisted until [confirmTakeover]. */
    private var recoveredSeed: ByteArray? = null

    /** #28 — recovered ACME account-key scalar (32 bytes), unwrapped from
     *  the envelope's escrowed `wrappedAcmeAccountKey` if present. Held in
     *  memory until [confirmTakeover] imports it into the recovered
     *  profile's Keystore slot. Null when the account never escrowed one. */
    private var recoveredAcmeScalar: ByteArray? = null

    /** MULTI second factor captured by [submitSecondFactor], threaded
     *  into the re-pair `totpProof`. */
    private var secondFactor: RePairInitiateRequest.TotpProof? = null

    /**
     * Entry point. Branch on the preflight:
     *   - no cloud backup → a clean STATE.
     *   - passphrase-gated record (hasFetchGate) → collect the passphrase
     *     first ([AwaitingPassphrase]); the gated fetch + unwrap runs in
     *     [submitPassphrase].
     *   - legacy record (no gate) → PRF unwrap directly (single →
     *     TakeoverReady, multi → AwaitingSecondFactor).
     */
    suspend fun begin() {
        if (!resolution.recovery.present) {
            // The single/multi-with-no-working-device dead end is a
            // node in the tree, NOT a 404. The host renders the copy.
            _phase.value = LoginPhase.NoCloudBackup(single = !isMulti)
            return
        }
        if (resolution.recovery.hasFetchGate) {
            // Modern record: the ciphertext is gated behind the
            // passphrase-derived fetchToken — collect the passphrase.
            _phase.value = LoginPhase.AwaitingPassphrase(single = !isMulti)
            return
        }
        // Legacy record (predates the passphrase gate): unwrap with the
        // fixed-salt PRF directly.
        runRecovery()
    }

    /**
     * Passphrase-gated restore (Task #74). Derives the secrets (Argon2id,
     * off the main thread), runs the gated fetch, asserts the returned
     * prfSaltHash matches the locally-derived prfSalt (refusing on
     * mismatch), then PRF-asserts with prfSalt and unwraps the UMK + the
     * escrowed ACME key. On success: single → TakeoverReady, multi →
     * AwaitingSecondFactor.
     */
    suspend fun submitPassphrase(passphrase: String) {
        if (_phase.value !is LoginPhase.AwaitingPassphrase) return
        _phase.value = LoginPhase.Recovering
        try {
            val result = withContext(Dispatchers.Default) {
                CloudRecoveryEnrollment.restore(
                    server = server,
                    passkeys = webAuthnCeremony(),
                    username = username,
                    passphrase = passphrase,
                    now = now(),
                )
            }
            require(result.umkSeed.size == 32) { "recovered UMK isn't 32 bytes" }
            recoveredSeed = result.umkSeed
            recoveredAcmeScalar = result.acmeScalar
            _phase.value = if (isMulti) {
                LoginPhase.AwaitingSecondFactor
            } else {
                LoginPhase.TakeoverReady(resolution.grace)
            }
        } catch (t: Throwable) {
            _phase.value = LoginPhase.Failed(humanizedError(t))
        }
    }

    /** Adapt the [WebAuthnProvider] to the [CloudRecoveryEnrollment.
     *  PasskeyCeremony] seam the shared restore helper consumes. Restore
     *  only ever calls [CloudRecoveryEnrollment.PasskeyCeremony.assert]
     *  (PRF-get with the passphrase-derived prfSalt); create is unreachable
     *  here so it fails loudly if ever wired wrong. */
    private fun webAuthnCeremony(): CloudRecoveryEnrollment.PasskeyCeremony =
        object : CloudRecoveryEnrollment.PasskeyCeremony {
            override suspend fun create(username: String, prfEvalInput: ByteArray): Pair<String, ByteArray> =
                throw IllegalStateException("login takeover never creates a passkey")

            override suspend fun assert(credentialId: String, prfEvalInput: ByteArray): ByteArray =
                webauthn.prfAssertWithSalt(credentialId, prfEvalInput)
        }

    /** Run the passkey-PRF assertion + unwrap. On success: single lands
     *  on [LoginPhase.TakeoverReady]; multi gates on the second factor
     *  first. */
    private suspend fun runRecovery() {
        _phase.value = LoginPhase.Recovering
        try {
            val seed = unwrapUmk()
            require(seed.size == 32) { "recovered UMK isn't 32 bytes" }
            recoveredSeed = seed
            _phase.value = if (isMulti) {
                LoginPhase.AwaitingSecondFactor
            } else {
                LoginPhase.TakeoverReady(resolution.grace)
            }
        } catch (t: Throwable) {
            _phase.value = LoginPhase.Failed(humanizedError(t))
        }
    }

    /** Fetch the cloud envelope, PRF-assert against its credentialId,
     *  unwrap the UMK seed. The Mock WebAuthnProvider derives a stable
     *  per-credentialId PRF secret so the wrap+unwrap round-trips. */
    private suspend fun unwrapUmk(): ByteArray {
        // Prefer the credentialId carried in the preflight; fall back to
        // the envelope's own id (they agree). Without one we can't pick
        // the passkey to assert.
        val envelope = server.fetchRecoveryEnvelope(
            resolution.recovery.credentialId ?: error("no recovery credential"),
        )
        val prfSecret = webauthn.prfAssert(envelope.credentialId)
        // #28 — if the account escrowed its ACME account key, unwrap it now
        // (same PRF secret, separate HKDF salt) and hold it for the
        // confirmed takeover to import. Non-fatal: a failure here must never
        // block the UMK recovery — cert-minting can be re-established later.
        recoveredAcmeScalar = envelope.wrappedAcmeAccountKey?.let { wrapped ->
            try {
                AcmeAccountKey.unwrapFromEscrow(wrapped, prfSecret)
            } catch (_: Throwable) {
                null
            }
        }
        return Recovery.unwrap(
            wrappedUmkBase64 = envelope.wrappedUmk,
            prfSecret = prfSecret,
        )
    }

    /**
     * MULTI only — capture the recovery TOTP (6-digit) or a single-use
     * recovery code. [isRecoveryCode] tags which the Worker should
     * verify against (`method: "totp" | "recovery"`). Advances to
     * [LoginPhase.TakeoverReady]; the actual `totpProof` is sent inside
     * [confirmTakeover] so the user can still back out of the grace
     * explainer.
     */
    fun submitSecondFactor(code: String, isRecoveryCode: Boolean) {
        if (_phase.value != LoginPhase.AwaitingSecondFactor) return
        val trimmed = code.trim()
        if (trimmed.isEmpty()) {
            _phase.value = LoginPhase.Failed("Enter your recovery code.")
            return
        }
        secondFactor = RePairInitiateRequest.TotpProof(
            code = trimmed,
            method = if (isRecoveryCode) "recovery" else "totp",
        )
        _phase.value = LoginPhase.TakeoverReady(resolution.grace)
    }

    /**
     * Confirm the takeover (the user accepted the grace explainer):
     *
     *   1. installUmk(seed) — the recovered seed becomes this device's
     *      UMK; deriveIRK now derives the recovered identity's IRK.
     *   2. INITIATE re-pair (POST /api/users/:u/re-pair) signed by the
     *      NEW IRK — for MULTI, carrying the collected `totpProof`.
     *   3. Stamp this device "admin" on the active profile (the
     *      no-lockout marker).
     *   4. completeOnboarding(resolved username, empty pods).
     *
     * Phase 4 wires the grace countdown + completion polling; here we
     * only START the clock. We DON'T flip the local IRK version to the
     * new one — that happens on completion (Phase 4), matching the
     * ReplaceDevice ceremony's setPendingIrkRotationVersion discipline.
     */
    suspend fun confirmTakeover() {
        val seed = recoveredSeed ?: run {
            _phase.value = LoginPhase.Failed("Recovered key missing — start over.")
            return
        }
        if (isMulti && secondFactor == null) {
            // Defensive: the host shouldn't reach here without a factor.
            _phase.value = LoginPhase.AwaitingSecondFactor
            return
        }
        _phase.value = LoginPhase.TakingOver
        try {
            // 0. Multi-profile keying (W3) — point the Keystore at the
            //    recovered cloud's per-profile device-key slot BEFORE
            //    installing the recovered UMK, so a takeover of a SECOND
            //    cloud on a phone that already holds another profile
            //    lands its UMK in its own slot instead of clobbering the
            //    existing one. profileId = lowercased resolved username.
            Keystore.setActiveProfile(username)

            // 1. Install the recovered UMK. After this deriveIRK derives
            //    the recovered identity's keys. installUmk resets the IRK
            //    version to v1 and sweeps stale per-version caches.
            Keystore.installUmk(seed)

            // 1b. #28 — restore the recovered ACME account key into the now-
            //     active profile's slot, re-establishing cert-minting
            //     authority on this device. Non-fatal: never block the
            //     takeover if the import hiccups.
            recoveredAcmeScalar?.let { scalar ->
                try {
                    Keystore.importAcmeAccountKeyScalar(scalar)
                } catch (_: Throwable) { /* recoverable via a surviving admin device */ }
            }

            // 2. Recovery Phase A vs B (single-device only) — the decision
            //    the whole sign-out → recover → instant-repair round-trip
            //    rests on. Derive the IRK from the JUST-installed (recovered)
            //    UMK at its current version and compare its pubkey to the
            //    account's currently registered IRK:
            //
            //      • match (or no registered value from a pre-Phase-B
            //        Worker) ⇒ PHASE A. The recovered key IS the registered
            //        identity, so this device already holds it — pair
            //        immediately, no grace, no rotation, no re-pair. This is
            //        exactly what makes a Tier-2 SIGN OUT (key wiped, server
            //        untouched) come back cleanly: same key restored,
            //        instant re-pair.
            //
            //      • mismatch ⇒ PHASE B. The registered key rotated since
            //        the recovery envelope was written (another device ran
            //        Replace / Wipe). The recovered key is stale, so run a
            //        real re-pair against the LIVE key behind the grace
            //        window, carrying oldIrkPub = registeredIrkPubHex.
            //
            //    MULTI always takes the re-pair path — the instant-pair
            //    optimization is single-device only (multi already gated on
            //    a second factor) — and keys oldIrkPub on the locally
            //    derived current-version IRK as before.
            val recoveredVersion = Keystore.currentIrkVersion()
            Keystore.deriveIRK("Confirm takeover", recoveredVersion)
            val recoveredPubHex = pubHexForVersion(recoveredVersion)

            if (!isMulti && recoveredKeyMatchesRegistered(recoveredPubHex)) {
                // Phase A — instant pair. The recovered key matches the
                // registered identity (or the Worker didn't surface one):
                // open the account directly, stamp this device admin, and
                // finish. No server-side re-pair, no grace clock, no
                // staged rotation.
                app.completeOnboarding(username = username, pods = emptyList())
                app.activeProfile?.let { active ->
                    app.addProfile(active.copy(deviceLabel = ADMIN_DEVICE_LABEL), setActive = true)
                }
                _phase.value = LoginPhase.Opened
                return
            }

            // Phase B (or any multi takeover) — derive the NEW (next-version)
            // IRK and sign the re-pair with it; the device proves it holds
            // the recovered key. oldIrkPub displaces the REGISTERED key:
            // Phase B keys on registeredIrkPubHex (the rotated live key);
            // multi falls back to the locally derived current-version pub.
            val oldVersion = recoveredVersion
            val newVersion = oldVersion + 1
            val newSign = Keystore.deriveIRK("Take over your Flagship account", newVersion)
            val oldPubHex = if (!isMulti) {
                resolution.registeredIrkPubHex ?: recoveredPubHex
            } else {
                recoveredPubHex
            }
            val newPubHex = pubHexForVersion(newVersion)

            val issuedAt = now()
            val canonical = RePairInitiateClaim.canonicalBytes(
                username = username,
                newIrkPubHex = newPubHex,
                oldIrkPubHex = oldPubHex,
                issuedAt = issuedAt,
            )
            val signature = HexUtil.encode(newSign.sign(canonical))

            val resp = server.initiateRePair(
                username = username,
                body = RePairInitiateRequest(
                    request = RePairInitiateRequest.Inner(
                        username = username,
                        newIrkPub = newPubHex,
                        oldIrkPub = oldPubHex,
                        issuedAt = issuedAt,
                    ),
                    signature = signature,
                    // MULTI: the Worker REQUIRES the second factor here.
                    // SINGLE (#52): also required when the account has a
                    // second factor enrolled — the Worker's 401 routes us
                    // through AwaitingSecondFactor below, so by the retry
                    // `secondFactor` is set. Grace-only single accounts
                    // leave it null.
                    totpProof = secondFactor,
                ),
                ifMatch = null,
            )
            Keystore.setPendingIrkRotationVersion(newVersion)

            // Phase 4: the grace clock is now running server-side. We do
            // NOT open the account yet — pairing + the admin label happen
            // in completeTakeover() once the grace elapses.
            _phase.value = LoginPhase.Grace(
                completesAt = resp.completesAt,
                graceModel = resolution.grace,
            )
        } catch (t: Throwable) {
            // #52 — the cloud 401s a bare single-device initiate when the
            // account has a second factor enrolled. We sent NO proof, so
            // route into the existing second-factor state (the same UX
            // multi uses); submitSecondFactor() → TakeoverReady →
            // confirmTakeover() retries with the proof riding the body.
            if (secondFactor == null && isCredentialRequired(t)) {
                _phase.value = LoginPhase.AwaitingSecondFactor
                return
            }
            _phase.value = LoginPhase.Failed(humanizedError(t))
        }
    }

    /** #52 — true when the failure is the Worker's "second factor
     *  enrolled; prove it" 401 (the load-bearing "totpProof" substring,
     *  same detector the webapp uses). */
    private fun isCredentialRequired(t: Throwable): Boolean =
        t is HttpException && t.status == 401 && t.body.contains("totpProof")

    /**
     * Phase 4 — finalize the takeover once its grace has elapsed. The
     * re-pair COMPLETE endpoint is a public, idempotent CAS-swap with NO
     * signature (we POST an empty body via [FlagshipServerClient.
     * completeRePair]). On success we activate the staged IRK rotation
     * locally (pending → current), open the account as the resolved user,
     * and stamp this device "admin".
     */
    suspend fun completeTakeover() {
        if (_phase.value !is LoginPhase.Grace) return
        _phase.value = LoginPhase.TakingOver
        try {
            server.completeRePair(username)
            // Activate the staged rotation: the new IRK becomes current.
            Keystore.pendingIrkRotationVersion()?.let { pending ->
                Keystore.setCurrentIrkVersion(pending)
                Keystore.setPendingIrkRotationVersion(null)
            }
            // Open as the RESOLVED user with ZERO pods, then stamp admin.
            app.completeOnboarding(username = username, pods = emptyList())
            app.activeProfile?.let { active ->
                app.addProfile(active.copy(deviceLabel = ADMIN_DEVICE_LABEL), setActive = true)
            }
            _phase.value = LoginPhase.Opened
        } catch (t: Throwable) {
            _phase.value = LoginPhase.Failed(humanizedError(t))
        }
    }

    /**
     * Recovery Phase A vs B — given the IRK pubkey derived from the
     * just-recovered UMK, returns true when it matches the account's
     * currently registered IRK (the key never moved ⇒ instant pair). A
     * `false` means the key was rotated since the recovery envelope was
     * written, so this device must re-pair with `oldIrkPub =
     * registeredIrkPubHex` behind the grace window. When we have no
     * registered value (pre-Phase-B Worker), we stay on the instant path
     * rather than force a needless re-pair. Mirror of iOS
     * RecoveryViewModel.recoveredKeyMatchesRegistered.
     */
    private fun recoveredKeyMatchesRegistered(recoveredIrkPubHex: String): Boolean {
        val registered = resolution.registeredIrkPubHex ?: return true
        return registered.lowercase() == recoveredIrkPubHex.lowercase()
    }

    private fun pubHexForVersion(version: Int): String {
        val seed = Keystore.requireIrkSeedForVersion(version)
        val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        return HexUtil.encode(pair.publicKey)
    }

    private fun humanizedError(t: Throwable): String {
        val m = t.message?.lowercase().orEmpty()
        return when {
            // #52 — the completion window (7d past the grace deadline)
            // elapsed and the cloud swept the pending row (410 Gone).
            // Unlike 404 this is NOT "already done" — start over.
            t is HttpException && t.status == 410 ->
                "This recovery expired before it was completed. Start again."
            m.contains("totpproof") || m.contains("invalid totp") || m.contains("401") ->
                "That recovery code didn't check out. Try the current 6-digit code or a recovery code."
            m.contains("no credential") || m.contains("no recovery") ||
                m.contains("nomatchingcredential") ->
                "We couldn't find a recovery passkey for this account."
            m.contains("cancel") -> "Recovery cancelled."
            // UX-B: never surface a raw status code / transport message —
            // fold network-class failures into plain language via the shared
            // humanizer (offline / temporary server problem / cert mismatch).
            NetworkErrorHumanizer.classify(t).kind != NetworkErrorHumanizer.Kind.UNKNOWN ->
                NetworkErrorHumanizer.humanize(t)
            else -> "Recovery couldn't be completed. Please try again."
        }
    }
}
