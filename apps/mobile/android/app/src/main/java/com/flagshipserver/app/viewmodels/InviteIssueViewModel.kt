// P6 — drives the per-app invite issuance form. Mirrors
// FlagshipUI/ViewModels/InviteIssueViewModel.swift 1:1 (state machine +
// privacy invariant: the daemon never sees the local label-book fields).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppInviteIssueRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.InviteLabel
import com.flagshipserver.app.core.InviteLabelBook
import com.flagshipserver.app.core.InviteUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class InviteIssueViewModel(
    val serviceId: String,
    val appUrl: String,
    private val client: ScreensClient,
    private val labelBook: InviteLabelBook,
    private val tagMint: () -> String = { InviteUtil.generateOpaqueTag() },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    sealed interface Phase {
        data object Idle : Phase
        data object Issuing : Phase
        data class Issued(val secret: String, val expiresAt: Long, val shareUrl: String) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    /** Form inputs as plain StateFlows; the screen drives them. */
    val displayName = MutableStateFlow("")
    val role = MutableStateFlow("member")
    val channel = MutableStateFlow("other")
    val sentTo = MutableStateFlow("")
    val notes = MutableStateFlow("")
    val contextNote = MutableStateFlow("")

    /** The opaqueTag minted at submit-time. Exposed so tests can assert
     *  the same tag flowed into both the wire request + the label-book row. */
    private val _lastOpaqueTag = MutableStateFlow<String?>(null)
    val lastOpaqueTag: StateFlow<String?> = _lastOpaqueTag.asStateFlow()

    fun issue(): Job = scope.launch {
        val trimmedDisplay = displayName.value.trim()
        if (trimmedDisplay.isEmpty()) {
            _phase.value = Phase.Failed("label is required (kept local)")
            return@launch
        }
        val trimmedRole = role.value.trim()
        if (trimmedRole.isEmpty()) {
            _phase.value = Phase.Failed("role is required")
            return@launch
        }
        val tag = tagMint()
        _lastOpaqueTag.value = tag
        _phase.value = Phase.Issuing
        val trimmedContext = contextNote.value.trim()
        val wireContextNote = trimmedContext.ifEmpty { null }
        val req = AppInviteIssueRequest(
            serviceId = serviceId,
            role = trimmedRole,
            opaqueTag = tag,
            contextNote = wireContextNote,
        )
        runCatching { client.appInviteIssue(req) }.fold(
            onSuccess = { resp ->
                // Persist BEFORE surfacing the share URL — see the iOS
                // mirror for the why (mid-share-sheet backgrounding).
                labelBook.put(
                    serviceId = serviceId,
                    opaqueTagHex = tag,
                    label = InviteLabel(
                        displayName = trimmedDisplay,
                        channel = channel.value,
                        sentTo = sentTo.value,
                        notes = notes.value,
                        sentAt = now(),
                    ),
                )
                val shareUrl = InviteUtil.buildShareUrl(appUrl, resp.secret, serviceId)
                _phase.value = Phase.Issued(
                    secret = resp.secret,
                    expiresAt = resp.expiresAt,
                    shareUrl = shareUrl,
                )
            },
            onFailure = { t -> _phase.value = Phase.Failed(failureMessage(t)) },
        )
    }

    fun reset() {
        _phase.value = Phase.Idle
        _lastOpaqueTag.value = null
    }

    private fun failureMessage(t: Throwable): String = when (t) {
        is ScreensError.Http -> t.message ?: "HTTP ${t.status}"
        else -> t.message ?: "couldn't issue invite"
    }
}
