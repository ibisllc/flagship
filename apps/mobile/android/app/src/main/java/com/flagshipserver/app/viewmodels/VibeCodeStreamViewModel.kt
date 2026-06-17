// Owns the live vibe-code (build-from-scratch) session: subscribes to the
// WebSocket-driven frame stream, accumulates tokens into a transcript,
// captures build logs, and surfaces the final deployed URL.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipUI/ViewModels/VibeCodeStreamViewModel.swift.
// The Android ScreensClient already exposes the identical
// `vibeCodeStream(sessionId): Flow<VibeCodeFrame>` (Live = WebSocket,
// Mock = scripted flow), so this consumes the same stream iOS does rather
// than the webapp's poll — the mobile reference is iOS.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.VibeCodeFrame
import com.flagshipserver.app.core.ActiveOperationsCenter
import com.flagshipserver.app.core.DeepLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class VibeCodeStreamViewModel(
    val sessionId: String,
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    /** Optional bridge to the global operations sliver. While the build is
     *  running this session shows up as "building <service> on <server>" in
     *  the sliver — and, because each tab keeps its nav stack alive, it stays
     *  there while the user works in another tab. Pure presentation; null in
     *  tests and previews leaves the VM behaviour unchanged. Mirror of iOS. */
    private val operations: ActiveOperationsCenter? = null,
    private val serviceLabel: String? = null,
    private val serverLabel: String? = null,
) {
    enum class Status { STREAMING, BUILDING, DEPLOYED, FAILED, DONE }

    private val _transcript = MutableStateFlow("")
    val transcript: StateFlow<String> = _transcript.asStateFlow()

    private val _buildLogs = MutableStateFlow<List<String>>(emptyList())
    val buildLogs: StateFlow<List<String>> = _buildLogs.asStateFlow()

    private val _manifestJson = MutableStateFlow<String?>(null)
    val manifestJson: StateFlow<String?> = _manifestJson.asStateFlow()

    private val _deployedServiceId = MutableStateFlow<String?>(null)
    val deployedServiceId: StateFlow<String?> = _deployedServiceId.asStateFlow()

    private val _deployedUrl = MutableStateFlow<String?>(null)
    val deployedUrl: StateFlow<String?> = _deployedUrl.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private val _status = MutableStateFlow(Status.STREAMING)
    val status: StateFlow<Status> = _status.asStateFlow()

    private var streamJob: Job? = null

    fun start(): Job {
        streamJob?.cancel()
        val job = scope.launch {
            client.vibeCodeStream(sessionId).collect { frame -> apply(frame) }
        }
        streamJob = job
        return job
    }

    fun cancel() {
        streamJob?.cancel()
        streamJob = null
        // Tearing down mid-build (e.g. the user pops the generating screen)
        // must not leave a phantom op in the sliver.
        operations?.removeBuild(sessionId)
    }

    /** Visible for tests: apply a single frame to the state. */
    internal fun apply(frame: VibeCodeFrame) {
        when (frame) {
            is VibeCodeFrame.Token -> _transcript.value += frame.text
            is VibeCodeFrame.ManifestEmit -> _manifestJson.value = frame.manifestJson
            is VibeCodeFrame.RepoCreate -> _buildLogs.value = _buildLogs.value + "Created git repo."
            is VibeCodeFrame.BuildStart -> {
                _status.value = Status.BUILDING
                _buildLogs.value = _buildLogs.value + "── BUILD START ──"
                // Surface this build in the global operations sliver, tapping
                // through to ITS OWN surface (the chat), not the server detail.
                operations?.upsertBuild(
                    id = sessionId,
                    subject = serviceLabel ?: "a service",
                    onServer = serverLabel,
                    target = DeepLink.VibeCodeChat(sessionId),
                )
            }
            is VibeCodeFrame.BuildLog -> _buildLogs.value = _buildLogs.value + frame.line
            is VibeCodeFrame.Deploy -> {
                _deployedServiceId.value = frame.serviceId
                _deployedUrl.value = frame.url
                _status.value = Status.DEPLOYED
                operations?.removeBuild(sessionId)
            }
            is VibeCodeFrame.Done -> {
                _status.value = Status.DONE
                operations?.removeBuild(sessionId)
            }
            is VibeCodeFrame.Err -> {
                _errorMessage.value = frame.message
                _status.value = Status.FAILED
                operations?.removeBuild(sessionId)
            }
        }
    }
}
