// Kotlin mirror of FlagshipCore/ToastCenter.swift.
//
// App-wide toast queue. Views publish info/success/warning/error
// messages; a Toaster overlay at the root of the scaffold renders the
// top-most one. Toasts are de-duplicated by (kind, message) so rapid
// identical publishes don't stack.

package com.flagship.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

class ToastCenter(
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val _queue = MutableStateFlow<List<Toast>>(emptyList())
    val queue: StateFlow<List<Toast>> = _queue.asStateFlow()

    fun info(message: String, duration: Duration = 3.seconds) =
        publish(Toast(kind = Toast.Kind.INFO, message = message, duration = duration))
    fun success(message: String, duration: Duration = 2500.milliseconds) =
        publish(Toast(kind = Toast.Kind.SUCCESS, message = message, duration = duration))
    fun warning(message: String, duration: Duration = 4.seconds) =
        publish(Toast(kind = Toast.Kind.WARNING, message = message, duration = duration))
    fun error(message: String, duration: Duration = 5.seconds) =
        publish(Toast(kind = Toast.Kind.ERROR, message = message, duration = duration))

    fun dismiss(id: String) {
        _queue.value = _queue.value.filterNot { it.id == id }
    }

    private fun publish(toast: Toast) {
        if (_queue.value.any { it.kind == toast.kind && it.message == toast.message }) return
        _queue.value = _queue.value + toast
        scope.launch {
            delay(toast.duration)
            dismiss(toast.id)
        }
    }
}

data class Toast(
    val id: String = UUID.randomUUID().toString(),
    val kind: Kind,
    val message: String,
    val duration: Duration,
) {
    enum class Kind { INFO, SUCCESS, WARNING, ERROR }
}

