// Mirror of FlagshipUI/ViewModels/ServerMetricsViewModel.swift.
// Polls /api/screens/server-metrics/<podId> every N seconds while the
// detail screen is on stage.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ServerMetricsResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ServerMetricsViewModel(
    private val podId: String,
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _state = MutableStateFlow<LoadingState<ServerMetricsResponse>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<ServerMetricsResponse>> = _state.asStateFlow()

    private var poller: Job? = null

    fun load() = scope.launch {
        _state.value = LoadingState.Loading
        try {
            _state.value = LoadingState.Loaded(client.serverMetrics(podId))
        } catch (t: Throwable) {
            _state.value = LoadingState.Failed(t.message ?: "metrics failed")
        }
    }

    fun startPolling(everySeconds: Int = 15) {
        stopPolling()
        poller = scope.launch {
            while (true) {
                load().join()
                delay(everySeconds * 1000L)
            }
        }
    }

    fun stopPolling() {
        poller?.cancel()
        poller = null
    }
}
