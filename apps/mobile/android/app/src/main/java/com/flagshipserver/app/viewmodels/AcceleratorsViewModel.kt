// The server page's GPU card (packages/server-daemon/src/gpu/http.ts): which GPUs the box has, which
// app holds or waits for each, and Stop, which takes a GPU back (POST /api/screens/accelerators/stop
// from this device's session; the box takes no signed order for it). A box with no GPU, or without
// this screen, shows no card. Mirror of iOS AcceleratorsViewModel and the webapp views/accelerators.js.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.R
import com.flagshipserver.app.api.AcceleratorHolder
import com.flagshipserver.app.api.AcceleratorsView
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.AcceleratorsCopy
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.GpuApprovalOrders
import com.flagshipserver.app.api.GpuApprovalRequest
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class AcceleratorsViewModel(
    private val client: ScreensClient,
    /** The box this page talks to: approvals are signed for it and no other. */
    private val serverDomain: String = "",
    /** One biometric per order, even in an unlocked session. */
    private val confirm: suspend (reason: String) -> Unit = { r -> BiometricAuthority.confirmNow(r) },
    /** The sensitive-order key: the admin root, else the IRK on an account without one. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    data class State(
        val view: AcceleratorsView? = null,
        /** The box has no GPU screen (an older release): no card. */
        val unsupported: Boolean = false,
        val loadError: String? = null,
        /** The allocation being stopped, or null. */
        val busy: String? = null,
        val notice: String? = null,
        val error: String? = null,
        /** Bumped on each Decline so the card recomposes without the hidden request. */
        val declines: Int = 0,
    ) {
        val shows: Boolean get() = !unsupported && (view?.let { AcceleratorsCopy.shows(it) } ?: (loadError != null))
    }

    companion object {
        /** Requests turned down on this device in this session, by server and installation. */
        private val declined = java.util.Collections.synchronizedSet(mutableSetOf<String>())
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    suspend fun load() {
        try {
            val v = client.accelerators()
            _state.value = _state.value.copy(view = v, loadError = null, unsupported = false)
        } catch (e: ScreensError.NotImplemented) {
            _state.value = _state.value.copy(unsupported = true)
        } catch (e: ScreensError.Http) {
            _state.value = if (e.status == 404 || e.status == 405) _state.value.copy(unsupported = true)
            else _state.value.copy(loadError = if (_state.value.view == null) FSStrings.get(R.string.accelerators_service_error) else null)
        } catch (t: Throwable) {
            if (_state.value.view == null) _state.value = _state.value.copy(loadError = FSStrings.get(R.string.accelerators_service_error))
        }
    }

    /** Approve [r]: the sensitive-order key signs flagship/gpu-approval/v1 over the terms the box listed. */
    suspend fun approve(r: GpuApprovalRequest): Boolean =
        sign(r, FSStrings.get(R.string.gpu_approval_sign_approve), AcceleratorsCopy.approved(r)) { server, at, key ->
            client.approveGpu(GpuApprovalOrders.sign(server, GpuApprovalOrders.ownerTerms(r, at), at, key))
        }

    /** The requests still to answer: Decline hides one on this device until the app asks with a new installation. */
    fun pending(v: com.flagshipserver.app.api.AcceleratorsView): List<GpuApprovalRequest> =
        v.pendingApprovals.filter { "${serverDomain.lowercase()}|${it.key}" !in declined }

    /** The box keeps no refusal (an app that isn't approved gets no GPU), so Decline sends nothing. */
    fun decline(r: GpuApprovalRequest): Boolean {
        declined += "${serverDomain.lowercase()}|${r.key}"
        _state.value = _state.value.copy(error = null, notice = AcceleratorsCopy.declined(r), declines = _state.value.declines + 1)
        return true
    }

    suspend fun withdraw(r: GpuApprovalRequest): Boolean =
        sign(r, FSStrings.get(R.string.gpu_approval_sign_withdraw), AcceleratorsCopy.withdrawn(r)) { server, at, key ->
            client.withdrawGpuApproval(GpuApprovalOrders.signWithdraw(server, r, at, key))
        }

    private suspend fun sign(r: GpuApprovalRequest, reason: String, done: String, send: suspend (String, Long, Ed25519Sign) -> Unit): Boolean {
        if (_state.value.busy != null) return false
        val server = serverDomain.lowercase()
        if (r.server.lowercase() != server) {
            _state.value = _state.value.copy(notice = null, error = FSStrings.get(R.string.gpu_approval_other_server))
            return false
        }
        _state.value = _state.value.copy(busy = r.key, notice = null, error = null)
        val ok = try {
            confirm(reason)
            send(server, now(), signer(reason))
            _state.value = _state.value.copy(busy = null, notice = done)
            true
        } catch (t: Throwable) {
            val msg = if (t is BiometricCancelled) FSStrings.get(R.string.local_ai_not_changed) else t.boxError() ?: t.userFacing()
            _state.value = _state.value.copy(busy = null, error = msg)
            false
        }
        load()
        return ok
    }

    /** Takes the GPU back from [h]'s app, then reads the GPUs again. True when the box stopped it. */
    suspend fun stop(h: AcceleratorHolder): Boolean {
        if (_state.value.busy != null) return false
        _state.value = _state.value.copy(busy = h.allocationId, notice = null, error = null)
        val ok = try {
            client.stopAccelerator(h.allocationId)
            _state.value = _state.value.copy(busy = null, notice = AcceleratorsCopy.stopped(h))
            true
        } catch (t: Throwable) {
            _state.value = _state.value.copy(busy = null, error = t.boxError() ?: t.userFacing())
            false
        }
        load()
        return ok
    }
}
