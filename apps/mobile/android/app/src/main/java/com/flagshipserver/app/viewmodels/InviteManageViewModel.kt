// P6 — drives the per-app invite manage screen. Mirrors
// FlagshipUI/ViewModels/InviteManageViewModel.swift 1:1.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppInviteAccessSummary
import com.flagshipserver.app.api.AppInvitePendingSummary
import com.flagshipserver.app.api.AppInviteRevokeRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.InviteLabel
import com.flagshipserver.app.core.InviteLabelBook
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class InviteManageViewModel(
    val serviceId: String,
    private val client: ScreensClient,
    private val labelBook: InviteLabelBook,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    data class Snapshot(
        val pending: List<AppInvitePendingSummary>,
        val access: List<AppInviteAccessSummary>,
    )

    private val _state = MutableStateFlow<LoadingState<Snapshot>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<Snapshot>> = _state.asStateFlow()

    private val _revokePending = MutableStateFlow(false)
    val revokePending: StateFlow<Boolean> = _revokePending.asStateFlow()

    private val _lastRevokeOutcome = MutableStateFlow<String?>(null)
    val lastRevokeOutcome: StateFlow<String?> = _lastRevokeOutcome.asStateFlow()

    fun load(): Job = scope.launch {
        _state.value = LoadingState.Loading
        runCatching {
            coroutineScope {
                val pending = async { client.appInviteList(serviceId) }
                val access = async { client.appInviteAccess(serviceId) }
                Pair(pending.await(), access.await())
            }
        }.fold(
            onSuccess = { (pendingResp, accessResp) ->
                _state.value = LoadingState.Loaded(
                    Snapshot(pending = pendingResp.pending, access = accessResp.access),
                )
            },
            onFailure = { t -> _state.value = LoadingState.Failed(failureMessage(t)) },
        )
    }

    /** Resolve the local label for a given opaqueTag. Returns null when
     *  the issuance happened on another device. */
    fun label(opaqueTagHex: String): InviteLabel? =
        labelBook.get(serviceId, opaqueTagHex)

    fun revokeInvite(inviteId: String, opaqueTagHex: String?): Job =
        runRevoke(AppInviteRevokeRequest.invite(serviceId, inviteId), opaqueTagHex)

    fun revokeAccess(irkPubKey: String, opaqueTagHex: String?): Job =
        runRevoke(AppInviteRevokeRequest.access(serviceId, irkPubKey), opaqueTagHex)

    private fun runRevoke(req: AppInviteRevokeRequest, localTag: String?): Job = scope.launch {
        _revokePending.value = true
        try {
            runCatching { client.appInviteRevoke(req) }.fold(
                onSuccess = { resp ->
                    if (!localTag.isNullOrEmpty()) {
                        labelBook.remove(serviceId, localTag)
                    }
                    _lastRevokeOutcome.value =
                        if (resp.alreadyRevoked == true) "already revoked" else "revoked"
                    load().join()
                },
                onFailure = { t -> _lastRevokeOutcome.value = failureMessage(t) },
            )
        } finally {
            _revokePending.value = false
        }
    }

    private fun failureMessage(t: Throwable): String = when (t) {
        is ScreensError.Http -> t.message ?: "HTTP ${t.status}"
        else -> t.message ?: "couldn't load invites"
    }
}
