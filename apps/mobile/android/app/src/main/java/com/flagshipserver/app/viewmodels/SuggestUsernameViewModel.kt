package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.UsernameSuggestion
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.ceil
import kotlin.math.max
import kotlin.random.Random

/**
 * Backs SuggestUsernameScreen (the CREATE path). Account creation hands the user
 * one random `<adjective>-<noun>` handle; the only edit affordance is regenerate,
 * rate-limited by an escalating per-device cooldown the server returns as
 * `retryAfterMs` (docs/username-suggestion-queue.md).
 *
 * Takes a narrow `suggest` lambda (not the whole client) so it's unit-testable.
 * The countdown TICK is driven by the screen (a LaunchedEffect) via [tickCooldown]
 * — the view-model only holds the seconds-remaining state.
 */
class SuggestUsernameViewModel(
    private val deviceKey: String = randomDeviceKey(),
    private val suggest: suspend (String) -> UsernameSuggestion,
) {
    private val _current = MutableStateFlow<String?>(null)
    /** The currently-shown handle (null until the first suggestion lands). */
    val current: StateFlow<String?> = _current.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    /** Seconds left before the next regenerate is allowed (0 = ready). */
    private val _cooldown = MutableStateFlow(0)
    val cooldownRemaining: StateFlow<Int> = _cooldown.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    fun canRegenerate(): Boolean = !_loading.value && _cooldown.value == 0
    fun canContinue(): Boolean = _current.value != null

    /** Fetch the FIRST suggestion (idempotent — a no-op once we have one). */
    suspend fun load() {
        if (_current.value == null) fetch()
    }

    /** Fetch a fresh suggestion; gated by the cooldown (the backend enforces it
     *  too, returning 429 → we map to throttled and re-arm). */
    suspend fun regenerate() {
        if (canRegenerate()) fetch()
    }

    /** Decrement the visible countdown by one second (called once per second by
     *  the screen while [cooldownRemaining] > 0). */
    fun tickCooldown() {
        if (_cooldown.value > 0) _cooldown.value -= 1
    }

    private suspend fun fetch() {
        _loading.value = true
        _error.value = null
        try {
            val s = suggest(deviceKey)
            if (s.name != null && !s.throttled) _current.value = s.name
            _cooldown.value = ceil(max(0, s.retryAfterMs) / 1000.0).toInt()
        } catch (_: Throwable) {
            _error.value = "Couldn't get a handle. Try again."
            _cooldown.value = 2
        } finally {
            _loading.value = false
        }
    }

    companion object {
        /** A throwaway per-sign-up device id, just for the regenerate throttle. */
        fun randomDeviceKey(): String =
            (0 until 16).joinToString("") { "%02x".format(Random.nextInt(256)) }
    }
}
