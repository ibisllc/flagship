// C7 — Replace device. Kotlin mirror of FlagshipUI's
// ReplaceDeviceViewModel. Drives the IRK rotation ceremony:
//
//   1. Derive NEW IRK locally at the next HKDF version.
//   2. Sign re-pair-initiate canonical bytes with the NEW IRK.
//   3. POST /api/users/:u/re-pair with the captured devices ETag.
//   4. Persist Keystore.setPendingIrkRotationVersion so a later
//      complete() call finalizes the swap after the 24h grace.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.PendingRePairSnapshot
import com.flagshipserver.app.api.RePairInitiateRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.RePairInitiateClaim
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface ReplaceDevicePhase {
    data object Idle : ReplaceDevicePhase
    data object Signing : ReplaceDevicePhase
    data object Posting : ReplaceDevicePhase
    data class Pending(val completesAt: Long) : ReplaceDevicePhase
    data object Completing : ReplaceDevicePhase
    data object Completed : ReplaceDevicePhase
    data class Failed(val message: String) : ReplaceDevicePhase
}

class ReplaceDeviceViewModel(
    private val server: FlagshipServerClient,
    private val username: () -> String?,
) : ViewModel() {
    private val _phase = MutableStateFlow<ReplaceDevicePhase>(ReplaceDevicePhase.Idle)
    val phase: StateFlow<ReplaceDevicePhase> = _phase.asStateFlow()

    /** H5 — re-seat the VM into [ReplaceDevicePhase.Pending] from a known
     *  deadline, used when the finalize screen is (re)opened for an
     *  already-initiated rotation (straight after `initiate`, or from the
     *  M4 banner's "Finalize now"). Pure local state; touches no network.
     *  No-op once a terminal/active phase is in progress so an in-flight
     *  `complete` is never clobbered. Mirrors iOS `resume`. */
    fun resume(completesAt: Long) {
        when (_phase.value) {
            is ReplaceDevicePhase.Idle,
            is ReplaceDevicePhase.Pending,
            is ReplaceDevicePhase.Failed,
            -> _phase.value = ReplaceDevicePhase.Pending(completesAt)
            else -> Unit
        }
    }

    companion object {
        /** H5 — whether the 24-hour grace window has elapsed relative to
         *  [now]. Pure + injectable so the finalize screen's countdown +
         *  button-gate are unit-testable. Mirrors iOS `graceElapsed`. */
        fun graceElapsed(completesAt: Long, now: Long = System.currentTimeMillis()): Boolean =
            now >= completesAt

        /** M4 — should the Trusted-devices "Replace pending" banner render
         *  for this snapshot? Mirrors the webapp's `shouldRenderBanner` +
         *  iOS `shouldRenderPendingBanner`: a missing snapshot, a missing
         *  row, or an OBJECTED row (cancelled by another device) all mean
         *  "no banner". Pure so the gate is unit-tested without Compose. */
        fun shouldRenderPendingBanner(snapshot: PendingRePairSnapshot?): Boolean {
            val pending = snapshot?.pending ?: return false
            return pending.objectedAt == null
        }
    }

    suspend fun initiate(currentEtag: String?) {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = ReplaceDevicePhase.Failed("No active account on this device.")
            return
        }
        _phase.value = ReplaceDevicePhase.Signing

        val oldVersion = Keystore.currentIrkVersion()
        val newVersion = oldVersion + 1
        val oldSign: Ed25519Sign
        val newSign: Ed25519Sign
        val oldPubHex: String
        val newPubHex: String
        try {
            oldSign = Keystore.deriveIRK("Confirm replace device", oldVersion)
            newSign = Keystore.deriveIRK("Authorize replace device", newVersion)
            // Pubkey derivation re-creates the keypair from the seed.
            // We can't read the seed back out (Keystore caches it
            // privately), so use irkPubHex helper variants per
            // version. The current Keystore exposes only the active
            // version's pubkey; for the inactive (new) version we
            // need to derive locally. The Ed25519Sign primitive
            // doesn't expose the public key; we rebuild via the
            // seed-cache that deriveIRK just wrote.
            oldPubHex = pubHexForVersion(oldVersion)
            newPubHex = pubHexForVersion(newVersion)
        } catch (e: Throwable) {
            _phase.value = ReplaceDevicePhase.Failed("Couldn't access your account keys: ${e.message}")
            return
        }
        val issuedAt = System.currentTimeMillis()
        val canonical = RePairInitiateClaim.canonicalBytes(
            username = user,
            newIrkPubHex = newPubHex,
            oldIrkPubHex = oldPubHex,
            issuedAt = issuedAt,
        )
        val signature = newSign.sign(canonical)

        _phase.value = ReplaceDevicePhase.Posting
        try {
            val resp = server.initiateRePair(
                username = user,
                body = RePairInitiateRequest(
                    request = RePairInitiateRequest.Inner(
                        username = user,
                        newIrkPub = newPubHex,
                        oldIrkPub = oldPubHex,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
                ifMatch = currentEtag,
            )
            Keystore.setPendingIrkRotationVersion(newVersion)
            _phase.value = ReplaceDevicePhase.Pending(resp.completesAt)
        } catch (e: Throwable) {
            val msg = e.message.orEmpty()
            val friendly = when {
                msg.contains("412") -> "Your device list changed in the background. Refresh and try again."
                msg.contains("409") -> "A device replacement is already pending on this account."
                else -> "Couldn't reach the server: $msg"
            }
            _phase.value = ReplaceDevicePhase.Failed(friendly)
        }
    }

    suspend fun complete() {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = ReplaceDevicePhase.Failed("No active account on this device.")
            return
        }
        val pending = Keystore.pendingIrkRotationVersion()
        if (pending == null) {
            _phase.value = ReplaceDevicePhase.Failed("No pending rotation found on this device.")
            return
        }
        _phase.value = ReplaceDevicePhase.Completing
        try {
            server.completeRePair(user)
            Keystore.setCurrentIrkVersion(pending)
            Keystore.setPendingIrkRotationVersion(null)
            // The IRK just rotated. Any watch-delegate key was attested by the
            // OLD IRK, so .com's list re-verify already stops honoring it (the
            // primary auto-revoke). Clear the orphaned local key.
            Keystore.clearWatchDelegate()
            _phase.value = ReplaceDevicePhase.Completed
        } catch (e: Throwable) {
            val msg = e.message.orEmpty()
            val friendly = when {
                msg.contains("425") -> "The 24-hour grace hasn't ended yet. Try again later."
                msg.contains("409") -> {
                    // Server rejected — clear local pending so the
                    // UI doesn't keep showing a phantom pending
                    // state.
                    Keystore.setPendingIrkRotationVersion(null)
                    "Another device objected to this rotation. Local state stays unchanged."
                }
                else -> "Couldn't complete: $msg"
            }
            _phase.value = ReplaceDevicePhase.Failed(friendly)
        }
    }

    private suspend fun pubHexForVersion(version: Int): String {
        // The Keystore caches an Ed25519 seed in SharedPreferences
        // per-version. We re-derive the pub key from that seed via
        // Tink's keypair constructor — same primitive
        // Keystore.irkPubHex uses for the active version.
        val seed = Keystore.requireIrkSeedForVersion(version)
        val pair = com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        return HexUtil.encode(pair.publicKey)
    }
}
