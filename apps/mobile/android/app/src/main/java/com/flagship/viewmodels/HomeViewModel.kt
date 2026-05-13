// Home tab + ServerDetail screen VM. Wraps the screens client's
// serverDetail() call in a LoadingState; ServerDetailScreen plus the
// Home overview both read from the same source.

package com.flagship.viewmodels

import com.flagship.api.ScreensClient
import com.flagship.api.ServerDetailResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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

    fun load() = scope.launch {
        _state.value = LoadingState.Loading
        try {
            _state.value = LoadingState.Loaded(client.serverDetail())
        } catch (t: Throwable) {
            _state.value = LoadingState.Failed(t.message ?: "failed to load")
        }
    }
}
