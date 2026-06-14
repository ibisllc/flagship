// Home tab + ServerDetail screen VM. Wraps the screens client's
// serverDetail() call in a LoadingState; ServerDetailScreen plus the
// Home overview both read from the same source.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ServerDetailResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class HomeViewModel(
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _state = MutableStateFlow<LoadingState<ServerDetailResponse>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<ServerDetailResponse>> = _state.asStateFlow()

    /** Single attempt — used by pull-to-refresh / the error-card retry. Only
     *  shows the skeleton on the first attempt (from Idle); keeps the last-good
     *  detail on a transient refresh failure instead of wiping it to an error. */
    fun load() = scope.launch {
        if (_state.value is LoadingState.Idle) _state.value = LoadingState.Loading
        try {
            _state.value = LoadingState.Loaded(client.serverDetail())
        } catch (t: Throwable) {
            if (_state.value !is LoadingState.Loaded) {
                _state.value = LoadingState.Failed(t.message ?: "failed to load")
            }
        }
    }

    /** Retry the BFF detail load until it lands. A box that JUST came online can
     *  take a few seconds before its daemon answers the detail BFF; a single
     *  load() would otherwise leave the page stuck (skeleton/error) until a
     *  manual refresh. Keeps showing the skeleton across retries (no error
     *  flash). Backoff 2s→15s; the launched job is cancelled when the VM's scope
     *  is torn down with the screen. */
    fun loadUntilLoaded() = scope.launch {
        if (_state.value !is LoadingState.Loaded) _state.value = LoadingState.Loading
        var delayMs = 2_000L
        while (true) {
            try {
                _state.value = LoadingState.Loaded(client.serverDetail())
                return@launch
            } catch (t: Throwable) {
                if (_state.value !is LoadingState.Loaded) _state.value = LoadingState.Loading
                delay(delayMs)
                delayMs = (delayMs * 2).coerceAtMost(15_000L)
            }
        }
    }
}
