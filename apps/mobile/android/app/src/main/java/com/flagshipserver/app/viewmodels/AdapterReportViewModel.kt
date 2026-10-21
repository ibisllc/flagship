// The owner's note about a shared adaptation that doesn't work. It goes to
// Flagship's public store through the box with only the adaptation's id;
// three reports retire an adaptation so the next server's AI makes a better
// one. Mirror of iOS AdapterReportSheet (ServiceDetailScreen.swift).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
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
    val ROW_TITLE get() = FSStrings.get(R.string.report_a_problem_with_this_adaptation)
    val TITLE get() = FSStrings.get(R.string.report_a_problem)
    val PROMPT get() = FSStrings.get(R.string.what_goes_wrong_it_helps_fix)
    val WARNING get() =
        FSStrings.get(R.string.please_dont_include_anything_that_identifies)
    val SENT get() = FSStrings.get(R.string.sent_thank_you)
    val SENT_NEXT get() = FSStrings.get(R.string.to_fix_it_on_your_server)

    fun rowCaption(repo: String) = FSStrings.get(R.string.it_was_set_up_from_a, repo)

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
