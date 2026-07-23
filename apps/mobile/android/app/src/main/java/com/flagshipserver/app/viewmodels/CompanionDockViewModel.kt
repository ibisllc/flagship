// Drives the phone side of desktop-initiated docking: scan/paste, explicit
// biometric approval, active-companion listing, and per-row revocation.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.CompanionListResponse
import com.flagshipserver.app.api.CompanionDockApproveRequest
import com.flagshipserver.app.api.CompanionRevokeRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.core.CompanionDockApprovalLink
import com.flagshipserver.app.core.CompanionDockApprovalPayload
import com.flagshipserver.app.keystore.BiometricAuthority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class CompanionDockViewModel(
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val expectedServerDomain: String? = null,
    private val authenticate: suspend (String) -> Unit = { reason ->
        BiometricAuthority.current()?.let { authority ->
            // Dock approval is a fresh, explicit ceremony even when the rest
            // of the unlocked app session has a warm biometric latch.
            authority.invalidate()
            authority.ensureFresh("Dock this browser", reason)
        }
    },
) {
    private val _state = MutableStateFlow<LoadingState<CompanionListResponse>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<CompanionListResponse>> = _state.asStateFlow()

    private val _stagedApproval = MutableStateFlow<CompanionDockApprovalPayload?>(null)
    val stagedApproval: StateFlow<CompanionDockApprovalPayload?> = _stagedApproval.asStateFlow()

    private val _approvalPending = MutableStateFlow(false)
    val approvalPending: StateFlow<Boolean> = _approvalPending.asStateFlow()

    private val _approvalError = MutableStateFlow<String?>(null)
    val approvalError: StateFlow<String?> = _approvalError.asStateFlow()

    private val _approvalComplete = MutableStateFlow(false)
    val approvalComplete: StateFlow<Boolean> = _approvalComplete.asStateFlow()

    private val _revokePending = MutableStateFlow<Set<String>>(emptySet())
    val revokePending: StateFlow<Set<String>> = _revokePending.asStateFlow()

    fun load(): Job = scope.launch {
        _state.value = LoadingState.Loading
        runCatching { client.companionList() }
            .fold(
                onSuccess = { _state.value = LoadingState.Loaded(it) },
                onFailure = { t -> _state.value = LoadingState.Failed(failureMessage(t)) },
            )
    }

    fun stageApproval(raw: String): Boolean {
        _approvalError.value = null
        _approvalComplete.value = false
        val parsed = CompanionDockApprovalLink.parse(raw)
        if (parsed == null) {
            _stagedApproval.value = null
            _approvalError.value = "This isn't a valid Flagship docking link."
            return false
        }
        if (expectedServerDomain != null && parsed.serverDomain != expectedServerDomain.lowercase()) {
            _stagedApproval.value = null
            _approvalError.value = "Switch to ${parsed.serverDomain} in Flagship, then scan this code again."
            return false
        }
        _stagedApproval.value = parsed
        return true
    }

    fun clearApproval() {
        _stagedApproval.value = null
        _approvalError.value = null
        _approvalComplete.value = false
    }

    fun approve(): Job = scope.launch {
        val approval = _stagedApproval.value ?: return@launch
        if (_approvalPending.value) return@launch
        _approvalPending.value = true
        _approvalError.value = null
        try {
            authenticate("Approve a four-hour keyless companion session")
            client.companionApproveDock(
                CompanionDockApproveRequest(
                    requestId = approval.requestId,
                    approvalSecret = approval.approvalSecret,
                ),
            )
            _approvalComplete.value = true
            _stagedApproval.value = null
            runCatching { client.companionList() }
                .onSuccess { _state.value = LoadingState.Loaded(it) }
        } catch (t: Throwable) {
            _approvalError.value = failureMessage(t)
        } finally {
            _approvalPending.value = false
        }
    }

    fun revoke(tokenPrefix: String): Job = scope.launch {
        _revokePending.value = _revokePending.value + tokenPrefix
        try {
            runCatching { client.companionRevoke(CompanionRevokeRequest(tokenPrefix = tokenPrefix)) }
                .fold(
                    onSuccess = {
                        val current = _state.value
                        if (current is LoadingState.Loaded) {
                            val remaining = current.value.companions.filterNot { it.tokenPrefix == tokenPrefix }
                            _state.value = LoadingState.Loaded(CompanionListResponse(companions = remaining))
                        }
                    },
                    onFailure = { t -> _state.value = LoadingState.Failed(failureMessage(t)) },
                )
        } finally {
            _revokePending.value = _revokePending.value - tokenPrefix
        }
    }

    private fun failureMessage(t: Throwable): String = when (t) {
        is ScreensError.Http -> NetworkErrorHumanizer.humanize(t)
        else -> t.message ?: "couldn't load companions"
    }
}
