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
//       7-day-grace explainer → on confirm: installUmk(seed),
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
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.RePairInitiateClaim
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.Recovery
import com.flagshipserver.app.keystore.WebAuthnProvider
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

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

    /** confirmTakeover() is running: installUmk → re-pair initiate →
     *  admin label → completeOnboarding. */
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

    /** MULTI second factor captured by [submitSecondFactor], threaded
     *  into the re-pair `totpProof`. */
    private var secondFactor: RePairInitiateRequest.TotpProof? = null

    /**
     * Entry point. Branch on the preflight:
     *   - no cloud backup → a clean STATE.
     *   - single → PRF unwrap → TakeoverReady.
     *   - multi  → PRF unwrap → AwaitingSecondFactor.
     */
    suspend fun begin() {
        if (!resolution.recovery.present) {
            // The single/multi-with-no-working-device dead end is a
            // node in the tree, NOT a 404. The host renders the copy.
            _phase.value = LoginPhase.NoCloudBackup(single = !isMulti)
            return
        }
        runRecovery()
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
        return Recovery.unwrap(
            ciphertextBase64 = envelope.wrappedUmkBase64,
            nonceBase64 = envelope.nonceBase64,
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
            // 1. Install the recovered UMK. After this deriveIRK derives
            //    the recovered identity's keys. installUmk resets the IRK
            //    version to v1 and sweeps stale per-version caches.
            Keystore.installUmk(seed)

            // 2. Derive OLD (v1, the recovered identity's current IRK) +
            //    NEW (v2) IRK and sign the re-pair with the NEW IRK — the
            //    entity proving it holds the recovered key. Mirror of the
            //    ReplaceDevice ceremony.
            val oldVersion = Keystore.currentIrkVersion()
            val newVersion = oldVersion + 1
            val newSign = Keystore.deriveIRK("Take over your Flagship account", newVersion)
            Keystore.deriveIRK("Confirm takeover", oldVersion)
            val oldPubHex = pubHexForVersion(oldVersion)
            val newPubHex = pubHexForVersion(newVersion)

            val issuedAt = now()
            val canonical = RePairInitiateClaim.canonicalBytes(
                username = username,
                newIrkPubHex = newPubHex,
                oldIrkPubHex = oldPubHex,
                issuedAt = issuedAt,
            )
            val signature = HexUtil.encode(newSign.sign(canonical))

            server.initiateRePair(
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
                    // SINGLE: omitted (single-device grace is the brake).
                    totpProof = if (isMulti) secondFactor else null,
                ),
                ifMatch = null,
            )
            Keystore.setPendingIrkRotationVersion(newVersion)

            // 3. Open the account as the RESOLVED user with ZERO pods,
            //    then stamp this device "admin" on the active profile.
            //    Phase 4 hydrates the real pod set from /devices.
            app.completeOnboarding(username = username, pods = emptyList())
            val active = app.activeProfile
            if (active != null) {
                app.addProfile(active.copy(deviceLabel = ADMIN_DEVICE_LABEL), setActive = true)
            }

            _phase.value = LoginPhase.Opened
        } catch (t: Throwable) {
            _phase.value = LoginPhase.Failed(humanizedError(t))
        }
    }

    private fun pubHexForVersion(version: Int): String {
        val seed = Keystore.requireIrkSeedForVersion(version)
        val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        return HexUtil.encode(pair.publicKey)
    }

    private fun humanizedError(t: Throwable): String {
        val m = t.message?.lowercase().orEmpty()
        return when {
            m.contains("totpproof") || m.contains("invalid totp") || m.contains("401") ->
                "That recovery code didn't check out. Try the current 6-digit code or a recovery code."
            m.contains("no credential") || m.contains("no recovery") ||
                m.contains("nomatchingcredential") ->
                "We couldn't find a recovery passkey for this account."
            else -> t.message ?: "Recovery cancelled or unavailable."
        }
    }
}
