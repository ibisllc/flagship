// P7 — dedicated tier-status / subscription view model.
//
// Loads GET /api/screens/tier-status (P1.16) via the daemon's
// ScreensClient + exposes the rendering-friendly derivations the
// canonical webapp `views/tier-status.js` computes inline. Mirrors
// FlagshipUI/ViewModels/TierStatusViewModel.swift byte-for-byte:
//   - same fixture shape (TierStatusResponse)
//   - same `usagePercent(used, quota)` formula (pct() in tier-status.js)

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.TierStatusResponse
import com.flagshipserver.app.core.NetworkErrorHumanizer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlin.math.min
import kotlin.math.roundToInt

class TierStatusViewModel(
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _state = MutableStateFlow<LoadingState<TierStatusResponse>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<TierStatusResponse>> = _state.asStateFlow()

    fun load() = scope.launch {
        _state.value = LoadingState.Loading
        runCatching { client.tierStatus() }
            .fold(
                onSuccess = { _state.value = LoadingState.Loaded(it) },
                onFailure = { t ->
                    val msg = when (t) {
                        is ScreensError.Http -> NetworkErrorHumanizer.humanize(t)
                        else -> t.message ?: "couldn't load tier status"
                    }
                    _state.value = LoadingState.Failed(msg)
                },
            )
    }

    companion object {
        /** Dispatcher usage progress in `0..100`. Mirrors `pct(used, quota)`
         *  in tier-status.js: 0 when either is missing or quota is 0, else
         *  `min(100, round(used / quota * 100))`. */
        fun usagePercent(used: Double?, quota: Double?): Int {
            if (used == null || quota == null || quota == 0.0) return 0
            return min(100, ((used / quota) * 100.0).roundToInt())
        }
    }
}
