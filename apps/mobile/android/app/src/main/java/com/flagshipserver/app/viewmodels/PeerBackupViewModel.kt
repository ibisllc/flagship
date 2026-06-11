// P9 — peer-backup management view model.
//
// Loads GET /api/screens/peer-backup/status via the daemon's ScreensClient
// and routes the participation toggle through
// POST /api/screens/peer-backup/toggle. Both endpoints return the same
// PeerBackupStatusResponse shape, so toggle replaces `state` with the
// freshly-served snapshot.
//
// Mirrors FlagshipUI/ViewModels/PeerBackupViewModel.swift 1:1.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.PeerBackupStatusResponse
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.NetworkErrorHumanizer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class PeerBackupViewModel(
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _state = MutableStateFlow<LoadingState<PeerBackupStatusResponse>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<PeerBackupStatusResponse>> = _state.asStateFlow()

    private val _togglePending = MutableStateFlow(false)
    val togglePending: StateFlow<Boolean> = _togglePending.asStateFlow()

    fun load() = scope.launch {
        _state.value = LoadingState.Loading
        runCatching { client.peerBackupStatus() }
            .fold(
                onSuccess = { _state.value = LoadingState.Loaded(it) },
                onFailure = { t -> _state.value = LoadingState.Failed(failureMessage(t)) },
            )
    }

    fun toggle() = scope.launch {
        val next = when (val s = _state.value) {
            is LoadingState.Loaded -> !s.value.participating
            else -> true
        }
        _togglePending.value = true
        try {
            runCatching { client.peerBackupToggle(next) }
                .fold(
                    onSuccess = { _state.value = LoadingState.Loaded(it) },
                    onFailure = { t -> _state.value = LoadingState.Failed(failureMessage(t)) },
                )
        } finally {
            _togglePending.value = false
        }
    }

    private fun failureMessage(t: Throwable): String = when (t) {
        is ScreensError.Http -> NetworkErrorHumanizer.humanize(t)
        else -> t.message ?: "couldn't load peer-backup status"
    }
}
