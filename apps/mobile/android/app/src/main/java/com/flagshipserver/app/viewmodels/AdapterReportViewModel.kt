// The owner's note about a shared adaptation that doesn't work. It goes to
// Flagship's public store through the box with only the adaptation's id;
// three reports retire an adaptation so the next server's AI makes a better
// one. Mirror of iOS AdapterReportSheet (ServiceDetailScreen.swift).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

object AdapterReport {
    const val MAX_LENGTH = 2000
    const val ROW_TITLE = "Report a problem with this adaptation"
    const val TITLE = "Report a problem"
    const val PROMPT = "What goes wrong? It helps fix the shared adaptation for everyone."
    const val WARNING =
        "Please don't include anything that identifies you, your server or your data: no names, addresses, emails or passwords."
    const val SENT = "Sent. Thank you."
    const val SENT_NEXT = "To fix it on your server now, use Edit this service to change it with AI."

    fun rowCaption(repo: String) = "It was set up from a shared adaptation of $repo"

    fun counter(detail: String) = "${detail.length} / $MAX_LENGTH"

    fun canSend(detail: String, sending: Boolean) =
        !sending && detail.isNotBlank() && detail.length <= MAX_LENGTH
}

class AdapterReportViewModel(
    private val serviceId: String,
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _sending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = _sending.asStateFlow()

    private val _sent = MutableStateFlow(false)
    val sent: StateFlow<Boolean> = _sent.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    fun send(detail: String): Job? {
        if (!AdapterReport.canSend(detail, _sending.value)) return null
        _sending.value = true
        _error.value = null
        return scope.launch {
            try {
                client.adapterReport(serviceId, detail.trim())
                _sent.value = true
            } catch (t: Throwable) {
                _error.value = t.boxError() ?: t.userFacing()
            } finally {
                _sending.value = false
            }
        }
    }
}
