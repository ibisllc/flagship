// The server page's "Container stack" (admin devices only; packages/server-daemon/src/archV2Switch.ts):
// the stack the box runs, a signed dry run of the move (the box's plan or why it can't), the same order
// sent for real, and how the move goes. Mirror of iOS StackSwitchViewModel and the webapp stack-switch.js.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.R
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.StackPlan
import com.flagshipserver.app.api.StackStatus
import com.flagshipserver.app.api.StackSwitchBody
import com.flagshipserver.app.api.StackSwitchOrderWire
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.StackSwitchOrder
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class StackSwitchViewModel(
    private val client: ScreensClient,
    private val serverDomain: String,
    private val confirm: suspend (reason: String) -> Unit = { r -> BiometricAuthority.confirmNow(r) },
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    data class State(
        val status: StackStatus? = null,
        val unsupported: Boolean = false,
        /** The dry run's plan, waiting for Move now. */
        val review: StackPlan? = null,
        val busy: Boolean = false,
        val restarting: Boolean = false,
        val notice: String? = null,
        val error: String? = null,
    ) {
        val shows: Boolean get() = !unsupported && status != null
        val moving: Boolean get() = restarting || status?.switchRecord?.state == "installing"
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    private var signed: StackSwitchBody? = null

    suspend fun load() {
        try {
            val s = client.stackStatus()
            _state.value = _state.value.copy(status = s, unsupported = false, restarting = _state.value.restarting && s.switchRecord?.state == "installing")
        } catch (e: ScreensError.NotImplemented) {
            _state.value = _state.value.copy(unsupported = true)
        } catch (e: ScreensError.Http) {
            if ((e.status == 404 || e.status == 405) && !_state.value.restarting) _state.value = _state.value.copy(unsupported = true)
        } catch (_: Throwable) {
            // A box restarting for the move doesn't answer: keep what we showed.
        }
    }

    private suspend fun signOrder(target: String, dryRun: Boolean): StackSwitchBody {
        val reason = FSStrings.get(R.string.stack_sign_reason)
        confirm(reason)
        val order = StackSwitchOrderWire(serverDomain.lowercase(), target, StackSwitchOrder.newNonce(), now())
        return StackSwitchOrder.sign(order, signer(reason), dryRun)
    }

    /** Sign the move once (one biometric) and ask the box for its plan without changing anything. */
    suspend fun prepare() {
        val target = _state.value.status?.plan?.target ?: return
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, error = null, notice = null)
        try {
            val body = signOrder(target, dryRun = true)
            val r = client.stackSwitch(body)
            signed = body
            _state.value = _state.value.copy(busy = false, review = r.plan ?: _state.value.status!!.plan)
        } catch (t: Throwable) {
            _state.value = _state.value.copy(busy = false, error = t.sentence())
        }
    }

    fun cancel() {
        signed = null
        _state.value = _state.value.copy(review = null)
    }

    /** Send the order the dry run checked (signed again only near the box's 5-minute limit). */
    suspend fun confirmMove() {
        val plan = _state.value.review ?: return
        if (_state.value.busy || plan.blockers.isNotEmpty()) return
        _state.value = _state.value.copy(busy = true, error = null)
        try {
            val s = signed
            val body = if (s == null || now() - s.order.issuedAt > 4 * 60_000) signOrder(plan.target, dryRun = false) else s.copy(dryRun = null)
            client.stackSwitch(body)
            signed = null
            _state.value = _state.value.copy(busy = false, review = null, restarting = true, notice = FSStrings.get(R.string.stack_started))
        } catch (t: Throwable) {
            _state.value = _state.value.copy(busy = false, error = t.sentence())
        }
        load()
    }

    /** Read again while the move is under way. */
    suspend fun follow(everyMs: Long = 3_000, rounds: Int = 200) {
        var n = 0
        while (_state.value.moving && n < rounds) {
            delay(everyMs)
            load()
            n++
        }
    }

    private fun Throwable.sentence(): String =
        if (this is BiometricCancelled) FSStrings.get(R.string.local_ai_not_changed) else boxError() ?: userFacing()
}
