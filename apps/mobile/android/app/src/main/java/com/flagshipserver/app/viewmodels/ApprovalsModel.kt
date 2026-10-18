package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.HttpException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The Server approvals list on Activity: what is waiting for the owner, and
 * answering one.
 *
 * An answer clears its card at once (the list is re-fetched behind it), and a
 * request that was already answered, by another device or an earlier tap
 * (`409 {"error":"already answered"}`), counts as answered: no error, the card
 * goes. Any other failure keeps the card and says why.
 *
 * Generic over the request so the rules are testable without the signing
 * ceremony; [idOf] names a request and [respond] runs the whole approval.
 */
class ApprovalsModel<T>(
    private val scope: CoroutineScope,
    private val idOf: (T) -> String,
    private val fetch: suspend () -> List<T>,
    private val respond: suspend (T) -> Unit,
    private val loadFailure: (Throwable) -> String,
    private val answerFailure: (T, Throwable) -> String,
) {
    sealed interface Outcome {
        data object Approved : Outcome
        /** Someone answered it first; nothing to report. */
        data object AlreadyAnswered : Outcome
        data class Failed(val message: String) : Outcome
    }

    private val _state = MutableStateFlow<LoadingState<List<T>>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<List<T>>> = _state.asStateFlow()

    private val _inFlightId = MutableStateFlow<String?>(null)
    val inFlightId: StateFlow<String?> = _inFlightId.asStateFlow()

    /** How many are waiting (0 until the list has loaded). */
    val count: Int get() = (_state.value as? LoadingState.Loaded)?.value?.size ?: 0

    /** Load the list. A refresh behind a shown list keeps it on screen; only
     *  the first load (or a retry after a failure) shows the skeleton. */
    fun reload(): Job = scope.launch {
        val shown = _state.value as? LoadingState.Loaded
        if (shown == null) _state.value = LoadingState.Loading
        try {
            _state.value = LoadingState.Loaded(fetch())
        } catch (t: Throwable) {
            if (shown == null) _state.value = LoadingState.Failed(loadFailure(t))
        }
    }

    /** Answer [item]; [onOutcome] reports what happened. */
    fun approve(item: T, onOutcome: (Outcome) -> Unit = {}): Job = scope.launch {
        val id = idOf(item)
        if (_inFlightId.value != null) return@launch
        _inFlightId.value = id
        val outcome = try {
            respond(item)
            Outcome.Approved
        } catch (t: Throwable) {
            if (isAlreadyAnswered(t)) Outcome.AlreadyAnswered else Outcome.Failed(answerFailure(item, t))
        } finally {
            _inFlightId.value = null
        }
        if (outcome !is Outcome.Failed) removeLocally(id)
        onOutcome(outcome)
        if (outcome !is Outcome.Failed) reload()
    }

    private fun removeLocally(id: String) {
        val loaded = _state.value as? LoadingState.Loaded ?: return
        _state.value = LoadingState.Loaded(loaded.value.filterNot { idOf(it) == id })
    }

    companion object {
        /** The box or `.com` says this request was already answered. */
        fun isAlreadyAnswered(t: Throwable): Boolean =
            generateSequence(t) { it.cause }.take(6).any { c ->
                c is HttpException && c.status == 409
            }
    }
}
