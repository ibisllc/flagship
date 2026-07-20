// Phase 2 (login redesign) — OPEN ACCOUNT.
//
// Account creation is decoupled from server provisioning. Picking a
// username opens the *account*: ensure the UMK exists, derive the IRK,
// run the STANDALONE username claim (POST /api/username/claim) — NOT the
// one buried in CreateServer's registerControlPlane — name this device,
// then complete onboarding with ZERO pods so Home lands on the
// "add your first server" empty state. A server (pod) is a separate,
// later, repeatable resource added from Home.
//
// Mirror of the iOS open-account step (FlagshipUI/Onboarding +
// CreateServerViewModel claim extraction). The UMK lives in
// StrongBox-backed AndroidKeyStore (Keystore.generateUMK); the cached
// 32-byte seed Keystore.loadOrCreateUmkSeed mints is what backs the IRK
// HKDF, matching the iOS CryptoKit code-path.
//
// See docs/login-and-account-redesign.md (principles 1 + 6, Phase 2).

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.UsernameClaimRequest
import com.flagshipserver.app.core.AccountMetadata
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.UsernameClaim
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface OpenAccountPhase {
    /** Editing the device name; the primary button is armed. */
    data object Ready : OpenAccountPhase
    /** UMK ensure → claim → completeOnboarding in flight. */
    data object Working : OpenAccountPhase
    /** Claim succeeded + onboarding completed; the host should finish. */
    data object Opened : OpenAccountPhase
    /** Claim or key generation failed; render the message inline. */
    data class Failed(val message: String) : OpenAccountPhase
}

class OpenAccountViewModel(
    private val server: FlagshipServerClient,
    private val app: AppState,
    /** The handle resolved + verified-available on ChooseUsername. */
    val username: String,
    /** Wall-clock injectable for deterministic canonical-bytes tests. */
    private val now: () -> Long = { System.currentTimeMillis() },
    /** Ensure the UMK exists. BiometricSetupScreen normally mints the
     *  StrongBox AES anchor key one step earlier; this is the
     *  belt-and-braces fallback so the open-account step still works if
     *  the user reaches it directly. Behind a seam because StrongBox is
     *  unavailable on the JVM/Robolectric test path — the load-bearing
     *  seed + claim are exercised verbatim either way. */
    private val ensureHardwareUmk: () -> Unit = {
        runCatching { Keystore.generateUMK(useStrongBox = true) }
            .recoverCatching { Keystore.generateUMK(useStrongBox = false) }
        Unit
    },
) : ViewModel() {

    private val _phase = MutableStateFlow<OpenAccountPhase>(OpenAccountPhase.Ready)
    val phase: StateFlow<OpenAccountPhase> = _phase.asStateFlow()

    /** Default, user-overridable, human-readable device name. Build.MODEL
     *  isn't reachable from a pure VM, so the host passes it in; we fall
     *  back to "<username>'s phone". */
    fun defaultDeviceName(deviceModel: String?): String =
        deviceModel?.takeIf { it.isNotBlank() } ?: "$username's phone"

    /**
     * Ensure the UMK, run the STANDALONE username claim, record the
     * device name, then complete onboarding with an EMPTY pod set.
     *
     * Idempotent on retry: claimUsername is idempotent for the same
     * (username, irkPub); calling it twice from the same device key is a
     * no-op server-side, so a tapped-twice / retried open is safe.
     */
    suspend fun openAccount(deviceName: String) {
        if (_phase.value == OpenAccountPhase.Working) return
        _phase.value = OpenAccountPhase.Working
        val label = deviceName.trim().ifEmpty { defaultDeviceName(null) }
        try {
            // 0. Multi-profile keying (W3) — point the Keystore at THIS
            //    cloud's per-profile device-key slot BEFORE any key gen,
            //    so opening a SECOND account mints a fresh UMK in its own
            //    slot instead of clobbering the first profile's. The
            //    profileId is the lowercased username (Keystore
            //    normalizes). For the first/only profile this resolves to
            //    the legacy default slot only when no prior profile
            //    exists; here we always key by the explicit cloud so
            //    additional accounts never collide.
            Keystore.setActiveProfile(username)

            // 1. Ensure the UMK exists. The StrongBox AES anchor key +
            //    the cached 32-byte seed that backs the IRK HKDF.
            ensureHardwareUmk()
            Keystore.loadOrCreateUmkSeed()

            // 1b. Slice D — mint this account's ADMIN MASTER ROOT on the FIRST
            //    device, immediately after the UMK. A fresh random Ed25519
            //    keypair (NOT UMK-derived), sealed device-local; this device
            //    holds it ⇒ it is admin by default. Its pubkey is published to
            //    `.com` in the claim below + pinned into every recipe AuthCode.
            val adminRootPubHex = Keystore.generateAdminRoot()

            // 2. Derive the IRK + standalone claim. Compute the public
            //    half from the just-derived versioned seed (the canonical
            //    source under the active IRK version).
            val issuedAt = now()
            val irk = Keystore.deriveIRK("Open your Flagship account")
            val version = Keystore.currentIrkVersion()
            val irkSeed = Keystore.requireIrkSeedForVersion(version)
            val irkPubHex = HexUtil.encode(
                Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed).publicKey,
            )
            val claimSig = HexUtil.encode(
                irk.sign(
                    UsernameClaim.canonicalBytes(
                        username = username,
                        irkPubHex = irkPubHex,
                        issuedAt = issuedAt,
                    ),
                ),
            )
            server.claimUsername(
                UsernameClaimRequest(
                    request = UsernameClaimRequest.Inner(
                        username = username,
                        irkPub = irkPubHex,
                        issuedAt = issuedAt,
                    ),
                    signature = claimSig,
                    // Slice D — publish the admin master root so `.com` pins it
                    // at `usernames.admin_root_pub_hex` (a top-level sibling, not
                    // signature-covered; the box anchors authority via the
                    // signed AuthCode).
                    adminRootPub = adminRootPubHex,
                ),
            )

            // 3. Open the account with ZERO servers → Home empty-state.
            //    Arm the SKIPPABLE "Secure your account" backup nudge
            //    BEFORE flipping isPaired so the shell never renders
            //    without the overlay above it. Create path only.
            app.armSecureAccountNudge()
            app.completeOnboarding(username = username, pods = emptyList())
            // 4. Name this device. completeOnboarding upserts the profile
            //    with the (absent) device-capability label; re-upsert with
            //    the human-readable name so Settings / multi-profile read
            //    it back.
            val active = app.activeProfile
            if (active != null) app.addProfile(
                active.copy(deviceDisplayName = AccountMetadata.validateDisplayName(label)),
                setActive = true,
            )

            _phase.value = OpenAccountPhase.Opened
        } catch (t: Throwable) {
            _phase.value = OpenAccountPhase.Failed(t.message ?: "Couldn't open your account. Try again.")
        }
    }
}
