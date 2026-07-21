// Backs the per-server boot-unlock approval card on server-detail.
// DIRECTORY-DRIVEN: the box's pending request is detected by the pod's cheap
// `awaitingUnlock` flag (from the unauthenticated `/pods` directory — NO
// biometric), so the card surfaces the Approve/Deny prompt the instant the
// directory says the box is waiting, with no "check for unlock request" tap and
// no biometric just to look. The biometric fires ONCE, only when the owner taps
// Approve (the whole ceremony — mailbox fetch, unseal, response, lease — runs
// behind that one prompt). Kotlin mirror of iOS BootUnlockApprovalViewModel.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.core.SecretPurpose
import com.flagshipserver.app.core.SecretRequestCoordinator
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The narrow capability the VM needs from the boot-secret relay. Production
 *  backs this with [SecretRequestCoordinator] (built from the live mailbox +
 *  IRK, exactly as SecretRequestsScreen does); tests back it with a fake so the
 *  VM drives without network or biometric. Mirror of iOS `ApprovalSource`. */
interface ApprovalSource {
    /** One-tap approval for the directory-driven server card: fetch + verify
     *  the live unlock-key request for [serverDomain] and respond, all under a
     *  SINGLE biometric. Returns the deposited lease id (auto mode) or null.
     *  Throws when no live request is waiting. */
    suspend fun approvePendingUnlock(serverDomain: String, depositAutoLease: Boolean): String?
    /** One-tap approval for the directory-driven ENTITLEMENT card (serve-auth) —
     *  fetch + verify the live `entitlement` request and respond. */
    suspend fun approvePendingEntitlement(serverDomain: String): String?
}

/** [SecretRequestCoordinator] already IS the production approval source — this
 *  thin adapter exposes it under the testable interface. */
class CoordinatorApprovalSource(
    private val coordinator: SecretRequestCoordinator,
) : ApprovalSource {
    override suspend fun approvePendingUnlock(serverDomain: String, depositAutoLease: Boolean): String? =
        coordinator.approvePendingUnlock(serverDomain, depositAutoLease)
    override suspend fun approvePendingEntitlement(serverDomain: String): String? =
        coordinator.approvePendingEntitlement(serverDomain)
}

class BootUnlockApprovalViewModel(
    private val serverDomain: String,
    /** Builds the live approval source for the active account, or null when no
     *  account is signed in. Called lazily on Approve so the card can render
     *  the prompt even before sign-in resolves. */
    private val makeSource: () -> ApprovalSource?,
    /** "auto" servers deposit a self-unlock lease on approve; "approve" servers
     *  do not. Resolved from the per-server ServerSettingsStore so the approval
     *  matches the create-time choice. */
    private val depositAutoLease: () -> Boolean,
    /** Which Box Request Inbox lane this card approves: UNLOCK_KEY (release the
     *  disk key) or ENTITLEMENT (authorize the box to serve). The approve
     *  dispatch keys off this so ONE card type serves both lanes. */
    private val purpose: SecretPurpose = SecretPurpose.UNLOCK_KEY,
) : ViewModel() {

    sealed interface State {
        /** The directory doesn't show this box waiting — render nothing. */
        data object Idle : State

        /** The directory says the box is waiting; show Approve/Deny. No
         *  biometric has fired (or will, until the owner taps Approve). */
        data object RequestPending : State

        /** Approval crypto + POST in flight (the one biometric happened here). */
        data object Approving : State

        /** Approval delivered; the box should come online shortly. */
        data object Approved : State

        /** The approve failed (incl. the box already gave up). Retry re-arms. */
        data class Failed(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    /** Latches when the owner taps Deny, so the card doesn't immediately
     *  reappear while the directory flag is still set this session. */
    private var denied = false

    /** Directory-driven surfacing — NO biometric, NO network. The card calls
     *  this with the pod's `awaitingUnlock` flag on entry and whenever it
     *  changes. `true` arms the Approve/Deny prompt; `false` (box unlocked or
     *  gave up) clears it. Never disturbs an in-flight or terminal approve. */
    fun setAwaitingUnlock(awaiting: Boolean) {
        when (_state.value) {
            is State.Approving, is State.Approved -> return
            is State.Failed -> {
                // Keep a failure visible until the user acts; but if the box is
                // no longer waiting, the failure is moot — clear it.
                if (!awaiting) {
                    _state.value = State.Idle
                    denied = false
                }
                return
            }
            is State.Idle, is State.RequestPending -> Unit
        }
        if (awaiting) {
            _state.value = if (denied) State.Idle else State.RequestPending
        } else {
            denied = false
            _state.value = State.Idle
        }
    }

    /** Owner tapped Approve. ONE biometric ceremony: fetch + verify the live
     *  request, unseal the key, respond, and (auto mode) deposit the lease. */
    suspend fun approve() {
        val source = makeSource()
        if (source == null) {
            _state.value = State.Failed("Sign in to approve this box.")
            return
        }
        _state.value = State.Approving
        _state.value = try {
            when (purpose) {
                SecretPurpose.UNLOCK_KEY -> source.approvePendingUnlock(serverDomain, depositAutoLease())
                SecretPurpose.ENTITLEMENT -> source.approvePendingEntitlement(serverDomain)
            }
            State.Approved
        } catch (t: Throwable) {
            State.Failed(t.message ?: "Approval failed. Try again.")
        }
    }

    /** Owner tapped Deny — hide the prompt for this session without contacting
     *  the box (it simply times out on its own and power-cycles to re-ask). */
    fun deny() {
        denied = true
        _state.value = State.Idle
    }

    /** Re-arm after a failure (the card's Retry) — back to the pending prompt. */
    fun retry() {
        denied = false
        _state.value = State.RequestPending
    }
}
