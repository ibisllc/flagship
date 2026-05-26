// P14 — drives the Settings → Dock a browser surface. Mints a 60-second
// pairing ticket (renders as a QR), lists active companions, and routes
// per-row revocations. Mirrors FlagshipUI/ViewModels/CompanionDockViewModel.swift.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.CompanionListResponse
import com.flagshipserver.app.api.CompanionMintTicketRequest
import com.flagshipserver.app.api.CompanionMintTicketResponse
import com.flagshipserver.app.api.CompanionRevokeRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
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
) {
    private val _state = MutableStateFlow<LoadingState<CompanionListResponse>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<CompanionListResponse>> = _state.asStateFlow()

    private val _mintedTicket = MutableStateFlow<CompanionMintTicketResponse?>(null)
    val mintedTicket: StateFlow<CompanionMintTicketResponse?> = _mintedTicket.asStateFlow()

    private val _mintError = MutableStateFlow<String?>(null)
    val mintError: StateFlow<String?> = _mintError.asStateFlow()

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

    fun mint(label: String?): Job = scope.launch {
        _mintError.value = null
        val trimmed = label?.trim()?.ifEmpty { null }
        runCatching { client.companionMintTicket(CompanionMintTicketRequest(label = trimmed)) }
            .fold(
                onSuccess = { _mintedTicket.value = it },
                onFailure = { t -> _mintError.value = failureMessage(t) },
            )
    }

    fun dismissTicket() {
        _mintedTicket.value = null
        _mintError.value = null
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
        is ScreensError.Http -> t.message ?: "HTTP ${t.status}"
        else -> t.message ?: "couldn't load companions"
    }
}
