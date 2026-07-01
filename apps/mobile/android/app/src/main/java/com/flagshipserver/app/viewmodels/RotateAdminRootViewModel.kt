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
    /** Re-escrow the NEW root under the recovery credential so credential
     *  recovery can reproduce a valid rotation proof for it (D-3). Best-effort;
     *  the host wires it to a recovery re-enroll. Default no-op. */
    private val reEscrowNewRoot: suspend (ByteArray) -> Unit = {},
) : ViewModel() {

    private val _phase = MutableStateFlow<RotateAdminRootPhase>(RotateAdminRootPhase.Idle)
    val phase: StateFlow<RotateAdminRootPhase> = _phase.asStateFlow()

    /** The UI greys the control out when this device holds no admin root. */
    fun canRotate(): Boolean = hasAdminRoot()

    /**
     * Rotate the admin master root: load the OLD root (biometric), mint a NEW
     * random root, sign `old→new`, POST the proof to `.com`, then re-store +
     * re-escrow the NEW root.
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
            // Re-escrow so credential recovery reproduces a valid proof for the
            // NEW root. Non-fatal — a failure never leaves the rotation half-done
            // (the box already accepted the proof + re-pins on its next poll).
            try {
                reEscrowNewRoot(newSeed)
            } catch (_: Throwable) {
            }

            _phase.value = RotateAdminRootPhase.Done(newPub)
        } catch (t: Throwable) {
            _phase.value = RotateAdminRootPhase.Failed(
                t.message ?: "Couldn't rotate the admin key. Try again.",
            )
        }
    }
}
