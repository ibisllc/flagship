// Peer-backup status view model (docs/peer-backup.md).
//
// Loads GET /api/screens/peer-backup/status via the daemon's ScreensClient: the
// v2 screen (state, holders as Server 1..n, restore-by date, what this server
// keeps for others). Peer backup is a backup policy now, so there is no
// participation toggle here.
//
// Mirrors the webapp's views/peer-backup.js.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.PeerBackupStatusResponse
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.core.PeerBackup
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class PeerBackupViewModel(
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _state = MutableStateFlow<LoadingState<PeerBackupStatusResponse>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<PeerBackupStatusResponse>> = _state.asStateFlow()

    fun load() = scope.launch {
        _state.value = LoadingState.Loading
        runCatching { client.peerBackupStatus() }
            .fold(
                onSuccess = { _state.value = LoadingState.Loaded(it) },
                onFailure = { t -> _state.value = LoadingState.Failed(failureMessage(t)) },
            )
    }

    companion object {
        const val NOT_SET_UP = "Peer backup isn't set up on this server yet."

        fun failureMessage(t: Throwable): String = when {
            t is ScreensError.Http && t.status == 404 -> PeerBackup.OLDER_ENGINE
            t is ScreensError.Http && t.status == 503 -> NOT_SET_UP
            t is ScreensError.Http -> NetworkErrorHumanizer.humanize(t)
            else -> t.message ?: "couldn't load peer-backup status"
        }
    }
}
