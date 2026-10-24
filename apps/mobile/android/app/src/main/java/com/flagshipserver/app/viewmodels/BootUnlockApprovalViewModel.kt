// Backs the per-server boot-unlock approval card on server-detail.
// DIRECTORY-DRIVEN: the box's pending request is detected by the pod's cheap
// `awaitingUnlock` flag (from the unauthenticated `/pods` directory — NO
// biometric), so the card surfaces the Approve/Deny prompt the instant the
// directory says the box is waiting, with no "check for unlock request" tap and
// no biometric just to look. The biometric fires ONCE, only when the owner taps
// Approve (the whole ceremony — mailbox fetch, unseal, response, lease — runs
// behind that one prompt). Kotlin mirror of iOS BootUnlockApprovalViewModel.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.UserErrorText
import com.flagshipserver.app.core.BoxKeyChangedException
import com.flagshipserver.app.core.BoxKeyPins
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.core.SecretPurpose
import com.flagshipserver.app.core.SecretRequestCoordinator
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The narrow capability the VM needs from the boot-secret relay. Production
 *  backs this with [SecretRequestCoordinator] (built from the live mailbox +
 *  IRK, exactly as the Server approvals section does); tests back it with a fake so the
 *  VM drives without network or biometric. Mirror of iOS `ApprovalSource`. */
interface ApprovalSource {
    /** One-tap approval for the directory-driven server card: fetch + verify
     *  the live unlock-key request for [serverDomain] and respond, all under a
     *  SINGLE biometric. Returns the deposited lease id (auto mode) or null.
     *  Throws when no live request is waiting. */
    suspend fun approvePendingUnlock(serverDomain: String, depositAutoLease: Boolean, acceptFirstSightKey: String? = null): String?
    /** One-tap approval for the directory-driven ENTITLEMENT card (serve-auth) —
     *  fetch + verify the live `entitlement` request and respond. [acceptFirstSightKey]:
     *  the key whose code the owner was shown at a first sight (docs/first-contact.md). */
    suspend fun approvePendingEntitlement(serverDomain: String, acceptFirstSightKey: String? = null): String?
}

/** [SecretRequestCoordinator] already IS the production approval source — this
 *  thin adapter exposes it under the testable interface. */
class CoordinatorApprovalSource(
    private val coordinator: SecretRequestCoordinator,
) : ApprovalSource {
    override suspend fun approvePendingUnlock(serverDomain: String, depositAutoLease: Boolean, acceptFirstSightKey: String?): String? =
        coordinator.approvePendingUnlock(serverDomain, depositAutoLease, acceptFirstSightKey)
    override suspend fun approvePendingEntitlement(serverDomain: String, acceptFirstSightKey: String?): String? =
        coordinator.approvePendingEntitlement(serverDomain, acceptFirstSightKey)
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
    /** After a biometric, forgets the pin, so the server's next request goes through first contact
     *  again (its code above Approve). Injectable for tests. */
    private val confirmNewKey: suspend (BoxKeyChangedException) -> Unit = { e ->
        com.flagshipserver.app.keystore.BiometricAuthority.confirmNow(FSStrings.get(R.string.trust_the_new_key_of, e.serverDomain))
        BoxKeyPins.shared.forget(e.username, e.serverDomain)
    },
) : ViewModel() {

    sealed interface State {
        /** The directory doesn't show this box waiting — render nothing. */
        data object Idle : State

        /** The directory says the box is waiting; show Approve/Deny. No
         *  biometric has fired (or will, until the owner taps Approve). */
        data object RequestPending : State

        /** First sight (docs/first-contact.md): the code computed here from the key the box named,
         *  shown above Approve. Approving pins that key. */
        data class ConfirmCode(val look: com.flagshipserver.app.core.FirstLook) : State

        /** Approval crypto + POST in flight (the one biometric happened here). */
        data object Approving : State

        /** Approval delivered; the box should come online shortly. */
        data object Approved : State

        /** The approve failed (incl. the box already gave up). Retry re-arms. */
        data class Failed(val message: String) : State

        /** `.com` lists a box key other than the one this phone pinned:
         *  nothing was sent. The owner may trust the new key (a reinstall). */
        data class KeyChanged(val error: BoxKeyChangedException) : State
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
            is State.Approving, is State.Approved, is State.ConfirmCode -> return
            is State.Failed, is State.KeyChanged -> {
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
    suspend fun approve() = approveWith(acceptKey = null)

    /** The owner saw the code (or Studio's confirmation) and approves that very key. */
    suspend fun approveShownKey() {
        val look = (_state.value as? State.ConfirmCode)?.look ?: return
        approveWith(acceptKey = look.stkPubHex)
    }

    private suspend fun approveWith(acceptKey: String?) {
        val source = makeSource()
        if (source == null) {
            _state.value = State.Failed(FSStrings.get(R.string.sign_in_to_approve_this_server))
            return
        }
        _state.value = State.Approving
        _state.value = try {
            when (purpose) {
                SecretPurpose.UNLOCK_KEY -> source.approvePendingUnlock(serverDomain, depositAutoLease(), acceptKey)
                SecretPurpose.ENTITLEMENT -> source.approvePendingEntitlement(serverDomain, acceptKey)
            }
            State.Approved
        } catch (e: SecretRequestCoordinator.CoordinatorException.FirstLookRequired) {
            State.ConfirmCode(e.look)
        } catch (e: SecretRequestCoordinator.CoordinatorException.Refused) {
            State.Failed(e.reason.message())
        } catch (e: BoxKeyChangedException) {
            State.KeyChanged(e)
        } catch (t: Throwable) {
            State.Failed(UserErrorText.of(t, FSStrings.get(R.string.approval_failed_try_again)))
        }
    }

    /** The owner says the key change is theirs (a reinstall, a replacement): forget the pin after
     *  a biometric, then back to the prompt, where the next approval shows the server's code. */
    suspend fun trustNewKey() {
        val changed = (_state.value as? State.KeyChanged)?.error ?: return
        _state.value = try {
            confirmNewKey(changed)
            denied = false
            State.RequestPending
        } catch (t: Throwable) {
            State.Failed(UserErrorText.of(t, FSStrings.get(R.string.couldnt_confirm_try_again)))
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
