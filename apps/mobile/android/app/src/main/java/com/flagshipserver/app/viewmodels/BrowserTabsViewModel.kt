// P8 — backs BrowserTabsScreen. Lists the daemon's open Chromium tabs
// for a given serviceId (ScreensClient.browserTabsList → P1.10).
//
// This request talks straight to the (pinned) box, so a cert-pin hard-fail
// surfaces here as well as ordinary offline/timeout/5xx. UX-A/UX-B: route
// every failure through NetworkErrorHumanizer so the user sees plain language
// — and, on a pin mismatch, the distinguishable "someone may be intercepting"
// warning rather than a generic network error.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.api.BrowserTab
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.NetworkErrorHumanizer
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

    /** Set when the last failure was a box cert-pin mismatch (UX-A) — the UI
     *  promotes this to a security warning instead of a retry hint. */
    private val _certMismatch = MutableStateFlow(false)
    val certMismatch: StateFlow<Boolean> = _certMismatch.asStateFlow()

    fun load() = viewModelScope.launch {
        _state.value = LoadingState.Loading
        _certMismatch.value = false
        try {
            val resp = client.browserTabsList(serviceId)
            _state.value = LoadingState.Loaded(resp.tabs)
        } catch (t: Throwable) {
            val classified = NetworkErrorHumanizer.classify(t)
            _certMismatch.value = classified.kind == NetworkErrorHumanizer.Kind.CERT_PIN_MISMATCH
            _state.value = LoadingState.Failed(classified.message)
        }
    }
}
