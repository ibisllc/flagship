// Home tab + ServerDetail screen VM. Wraps the screens client's
// serverDetail() call in a LoadingState; ServerDetailScreen plus the
// Home overview both read from the same source.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.core.HttpException
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

    /** The box has no token from this device, or rejected the one it has (401).
     *  Retrying never helps until the owner pairs, so the page offers "Pair this
     *  server" instead. A 403 is not this: it can be an operation-level refusal.
     *  Mirror of iOS HomeViewModel.needsPairing. */
    private val _needsPairing = MutableStateFlow(false)
    val needsPairing: StateFlow<Boolean> = _needsPairing.asStateFlow()

    /** Failed attempts since the last answer, for the page's "connecting" and
     *  "not answering" states. */
    private val _failures = MutableStateFlow(0)
    val failures: StateFlow<Int> = _failures.asStateFlow()

    private var lastError: String? = null

    private suspend fun attempt(): Boolean = try {
        _state.value = LoadingState.Loaded(client.serverDetail())
        _needsPairing.value = false
        _failures.value = 0
        true
    } catch (t: Throwable) {
        _needsPairing.value = isNotPaired(t)
        lastError = t.message
        _failures.value += 1
        false
    }

    /** Single attempt — used by pull-to-refresh / the error-card retry. Only
     *  shows the skeleton on the first attempt (from Idle); keeps the last-good
     *  detail on a transient refresh failure instead of wiping it to an error. */
    fun load() = scope.launch {
        if (_state.value is LoadingState.Idle) _state.value = LoadingState.Loading
        val previous = _state.value
        if (!attempt() && previous !is LoadingState.Loaded) {
            _state.value = LoadingState.Failed(failureMessage())
        }
    }

    /** Retry the BFF detail load until it lands. A box that JUST came online can
     *  take a few seconds before its daemon answers the detail BFF; a single
     *  load() would otherwise leave the page stuck until a manual refresh. Keeps
     *  the state Loading across retries; the page reads [failures] to say it's
     *  connecting. Stops, settling on Failed, when the box needs pairing or when
     *  [wontAnswer] (the directory says it's offline, revoked or still coming
     *  up: one attempt, then the page's honest placeholder and a refresh drive).
     *  Backoff 2s→15s; cancelled with the VM's scope. */
    fun loadUntilLoaded(wontAnswer: Boolean = false) = scope.launch {
        if (_state.value !is LoadingState.Loaded) _state.value = LoadingState.Loading
        var delayMs = 2_000L
        while (true) {
            if (attempt()) return@launch
            if (_needsPairing.value || wontAnswer) {
                if (_state.value !is LoadingState.Loaded) _state.value = LoadingState.Failed(failureMessage())
                return@launch
            }
            if (_state.value !is LoadingState.Loaded) _state.value = LoadingState.Loading
            delay(delayMs)
            delayMs = (delayMs * 2).coerceAtMost(15_000L)
        }
    }

    private fun failureMessage(): String =
        if (_needsPairing.value) "This device isn't paired with this server yet." else lastError ?: "failed to load"

    companion object {
        fun isNotPaired(t: Throwable): Boolean = when (t) {
            is ScreensError.NoSessionToken -> true
            is ScreensError.Http -> t.status == 401
            is HttpException -> t.status == 401
            else -> false
        }
    }
}
