// P8 — backs BrowserTabsScreen. Lists the daemon's open Chromium tabs
// for a given serviceId (ScreensClient.browserTabsList → P1.10).

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.api.BrowserTab
import com.flagshipserver.app.api.ScreensClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class BrowserTabsViewModel(
    private val client: ScreensClient,
    private val serviceId: String,
) : ViewModel() {

    private val _state = MutableStateFlow<LoadingState<List<BrowserTab>>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<List<BrowserTab>>> = _state.asStateFlow()

    fun load() = viewModelScope.launch {
        _state.value = LoadingState.Loading
        try {
            val resp = client.browserTabsList(serviceId)
            _state.value = LoadingState.Loaded(resp.tabs)
        } catch (t: Throwable) {
            _state.value = LoadingState.Failed(t.message ?: "Failed to load tabs.")
        }
    }
}
