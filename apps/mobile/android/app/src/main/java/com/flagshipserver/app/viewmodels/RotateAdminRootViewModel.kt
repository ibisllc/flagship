// Slice D (docs/device-admin-tier-spec.md §5) — owner-facing "Rotate admin key".
//
// The owner mints a FRESH random admin master root and proves the hand-off with
// an old-root-signs-new-root `AdminRootRotation`. `.com` relays the signed proof;
// each box re-pins to the new root ONLY after verifying the proof against its
// pinned OLD root (never `.com`'s word — the box-side trust anchor stays the
// pinned key, §5). The OLD root reads are biometric-gated (signing a rotation is
// never silent).
//
// REVOKE SEMANTIC (§4.3): rotation EXCLUDES other admin devices that hold only
// the OLD bare root — once boxes re-pin, their old-root signatures stop
// verifying. That is the whole point of a rotation as a "cut off a lost/rogue
// admin" remedy; it is NOT additive. Grant-based admins are dropped via the
// separate grant-revocation path.
//
// ORDERING INVARIANTS: the rotation is COMMITTED (proof posted + new root
// stored device-local) before the recovery re-escrow step ever runs — the
// re-escrow (D-3) is a best-effort FOLLOW-UP that can never fail or unwind the
// rotation. When cloud recovery is enrolled the flow parks in
// [RotateAdminRootPhase.DoneNeedsRecoveryUpdate]: without a re-escrow the
// recovery envelope still wraps the DEAD old root, so a post-rotation
// credential recovery would restore a root no box accepts. The re-escrow is
// interactive (recovery passphrase + WebAuthn PRF assert EMIT the wrap key —
// consent-as-crypto, never a boolean), retryable on failure, and explicitly
// skippable (the UI warns). The NEW seed is held privately by the VM for the
// re-escrow step only — it never rides a Phase data class.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.AdminRootRotationRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.core.AdminRootRotation
import com.flagshipserver.app.core.AdminRootRotationClaim
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.SecureRandom

sealed interface RotateAdminRootPhase {
    data object Idle : RotateAdminRootPhase
    data object Rotating : RotateAdminRootPhase
    /** Success — carries the NEW admin-root pubkey (hex) now pinned locally. */
    data class Done(val newAdminRootPubHex: String) : RotateAdminRootPhase
    /** Rotation SUCCEEDED but cloud recovery still escrows the DEAD old root.
     *  The UI collects the recovery passphrase → [RotateAdminRootViewModel
     *  .updateRecoveryBackup] (retryable via [errorMessage]) or skips. */
    data class DoneNeedsRecoveryUpdate(
        val newAdminRootPubHex: String,
        val errorMessage: String? = null,
        val updating: Boolean = false,
    ) : RotateAdminRootPhase
    data class Failed(val message: String) : RotateAdminRootPhase
}

class RotateAdminRootViewModel(
    private val server: FlagshipServerClient,
    private val username: String,
    /** Mints the NEW random 32-byte admin-root seed. Injectable for
     *  deterministic tests. */
    private val mintSeed: () -> ByteArray = { ByteArray(32).also { SecureRandom().nextBytes(it) } },
    private val now: () -> Long = { System.currentTimeMillis() },
    /** True iff this device holds the admin master root. */
    private val hasAdminRoot: () -> Boolean = { Keystore.hasAdminRoot() },
    /** Loads the OLD admin-root SIGNER (biometric-gated in production). */
    private val loadOldSigner: suspend () -> Ed25519Sign = { Keystore.adminRootKey("Rotate your admin key") },
    /** The OLD admin-root pubkey hex held on this device. */
    private val oldPubHex: () -> String? = { Keystore.adminRootPubHex() },
    /** Re-store the NEW root device-local (replaces the old one). */
    private val storeNewRoot: (ByteArray) -> Unit = { Keystore.importAdminRoot(it) },
    /** Whether cloud recovery is enrolled — gates the post-rotation re-escrow
     *  prompt. Errors ⇒ best-effort skip (a rotation never fails on this). */
    private val recoveryEnrolled: suspend () -> Boolean = {
        runCatching { server.hasCloudRecovery(username) }.getOrDefault(false)
    },
    /** Re-wrap the NEW root under the EXISTING recovery credential (D-3 —
     *  CloudRecoveryEnrollment.reEscrowAdminRoot). The ceremony needs the
     *  foreground Activity, so the host composable injects the production
     *  wiring (mirroring how RecoveryScreen wires enroll()). */
    private val reEscrow: suspend (passphrase: String, newSeed: ByteArray) -> Unit = { _, _ ->
        error("re-escrow isn't wired on this surface")
    },
) : ViewModel() {

    private val _phase = MutableStateFlow<RotateAdminRootPhase>(RotateAdminRootPhase.Idle)
    val phase: StateFlow<RotateAdminRootPhase> = _phase.asStateFlow()

    /** The NEW seed, held ONLY between a successful rotate and the re-escrow
     *  resolution (update or skip). Never surfaced on a Phase. */
    private var pendingNewSeed: ByteArray? = null

    /** The UI greys the control out when this device holds no admin root. */
    fun canRotate(): Boolean = hasAdminRoot()

    /**
     * Rotate the admin master root: load the OLD root (biometric), mint a NEW
     * random root, sign `old→new`, POST the proof to `.com`, then re-store the
     * NEW root. With cloud recovery enrolled, park in DoneNeedsRecoveryUpdate
     * so the owner can re-escrow the NEW root (the rotation itself is already
     * committed either way).
     */
    suspend fun rotate() {
        if (!hasAdminRoot()) {
            _phase.value = RotateAdminRootPhase.Failed(
                "This device isn't an admin, so it can't rotate the admin key.",
            )
            return
        }
        _phase.value = RotateAdminRootPhase.Rotating
        try {
            val oldSigner = loadOldSigner() // biometric-gated read of the OLD root
            val old = (oldPubHex() ?: error("no admin root on this device")).lowercase()
            val newSeed = mintSeed()
            require(newSeed.size == 32) { "new admin root seed must be 32 bytes" }
            val newPub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(newSeed).publicKey)
            val issuedAt = now()

            // OLD signs OLD→NEW — byte-identical canonical bytes to the TS spine.
            val rotation = AdminRootRotation(
                username = username,
                oldAdminRootPub = old,
                newAdminRootPub = newPub,
                issuedAt = issuedAt,
            )
            val signatureHex = HexUtil.encode(AdminRootRotationClaim.sign(rotation, oldSigner))

            server.rotateAdminRoot(
                username = username,
                req = AdminRootRotationRequest(
                    rotation = AdminRootRotationRequest.Rotation(
                        username = username,
                        oldAdminRootPub = old,
                        newAdminRootPub = newPub,
                        issuedAt = issuedAt,
                    ),
                    signatureHex = signatureHex,
                ),
            )

            // Re-store the NEW root device-local (the OLD root is now dead).
            storeNewRoot(newSeed)

            // The rotation is committed from here on — nothing below may fail it.
            val enrolled = runCatching { recoveryEnrolled() }.getOrDefault(false)
            if (enrolled) {
                pendingNewSeed = newSeed
                _phase.value = RotateAdminRootPhase.DoneNeedsRecoveryUpdate(newPub)
            } else {
                _phase.value = RotateAdminRootPhase.Done(newPub)
            }
        } catch (t: Throwable) {
            _phase.value = RotateAdminRootPhase.Failed(
                t.message ?: "Couldn't rotate the admin key. Try again.",
            )
        }
    }

    /**
     * Re-wrap the NEW root under the existing recovery credential. Success →
     * Done; failure keeps DoneNeedsRecoveryUpdate with [RotateAdminRootPhase
     * .DoneNeedsRecoveryUpdate.errorMessage] set so the owner can retry.
     */
    suspend fun updateRecoveryBackup(passphrase: String) {
        val current = _phase.value as? RotateAdminRootPhase.DoneNeedsRecoveryUpdate ?: return
        val seed = pendingNewSeed
        if (seed == null) {
            _phase.value = RotateAdminRootPhase.Done(current.newAdminRootPubHex)
            return
        }
        _phase.value = current.copy(updating = true, errorMessage = null)
        try {
            reEscrow(passphrase, seed)
            pendingNewSeed = null
            _phase.value = RotateAdminRootPhase.Done(current.newAdminRootPubHex)
        } catch (t: Throwable) {
            _phase.value = current.copy(
                updating = false,
                errorMessage = t.message ?: "Couldn't update the recovery backup. Try again.",
            )
        }
    }

    /** Leave the recovery envelope holding the DEAD old root (owner's call —
     *  the UI shows a standing caution). */
    fun skipRecoveryUpdate() {
        val current = _phase.value as? RotateAdminRootPhase.DoneNeedsRecoveryUpdate ?: return
        pendingNewSeed = null
        _phase.value = RotateAdminRootPhase.Done(current.newAdminRootPubHex)
    }
}
