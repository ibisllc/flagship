// ViewModels for the "build a service" modes (git / mcp / journal).
// Each drives a paired-session-gated `/api/build/*` flow on the pod and
// mirrors the webapp reference (apps/web/public/webapp/views/build-*.js).
//
// MIRRORS: apps/mobile/ios/.../BuildModeViewModels.swift.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.BuildEnvRequest
import com.flagshipserver.app.api.BuildGitRequest
import com.flagshipserver.app.api.BuildJournalEntry
import com.flagshipserver.app.api.BuildMcpConnection
import com.flagshipserver.app.api.BuildMcpRequest
import com.flagshipserver.app.api.BuildSummary
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.NetworkErrorHumanizer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

private fun friendly(t: Throwable): String = when (t) {
    is ScreensError.Http -> NetworkErrorHumanizer.humanize(t)
    is ScreensError -> t.message ?: "Something went wrong."
    else -> t.message ?: "Something went wrong."
}

// ---------- git mode ---------------------------------------------------

/**
 * Git import: paste URL+ref → "Check repo" → fitness verdict → Install
 * (fit) or Build-with-AI (not fit). On a 503 from adapt the box has no
 * model wired; the screen falls back to from-scratch (signalled via
 * [GitPhase.AdaptUnavailable]).
 */
class BuildGitViewModel(
    private val client: BuildClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    /** Optional bridge to the global operations sliver. While a deploy is
     *  running this build shows up as "building <service> on <server>" in the
     *  sliver and survives navigation to another tab. Pure presentation; null
     *  in tests/previews leaves the VM behaviour unchanged. Mirror of iOS
     *  VibeCodeStreamViewModel's `operations`. */
    private val operations: com.flagshipserver.app.core.ActiveOperationsCenter? = null,
    private val serviceLabel: String? = null,
    private val serverLabel: String? = null,
    /** Where a tap on the sliver navigates — the deploy lands here. Defaulted
     *  null so callers without a target (and all existing call sites) compile;
     *  only set when [operations] is wired. */
    private val operationTarget: com.flagshipserver.app.core.DeepLink? = null,
) {
    sealed interface GitPhase {
        data object Idle : GitPhase
        data object Checking : GitPhase
        /** Verdict in. `fit` true ⇒ deterministic install offer. */
        data class Verdict(val fit: Boolean, val reason: String, val fileCount: Int) : GitPhase
        data object Adapting : GitPhase
        /** Adapt succeeded; ready to deploy. */
        data class Adapted(val fileCount: Int) : GitPhase
        data object Deploying : GitPhase
        data class Deployed(val url: String) : GitPhase
        /** The box has no model wired — caller should route to scratch. */
        data object AdaptUnavailable : GitPhase
        data class Failed(val message: String) : GitPhase
    }

    private val _phase = MutableStateFlow<GitPhase>(GitPhase.Idle)
    val phase: StateFlow<GitPhase> = _phase.asStateFlow()

    /** Set once a repo is checked; reused by adapt/deploy. */
    var buildId: String? = null
        private set

    fun checkRepo(gitUrl: String, ref: String): Job = scope.launch {
        _phase.value = GitPhase.Checking
        try {
            val r = client.gitImport(
                BuildGitRequest(gitUrl = gitUrl.trim(), ref = ref.trim().ifEmpty { null }),
            )
            buildId = r.buildId
            _phase.value = GitPhase.Verdict(fit = r.fit, reason = r.reason, fileCount = r.fileCount)
        } catch (t: Throwable) {
            _phase.value = GitPhase.Failed(friendly(t))
        }
    }

    fun adapt(
        instructions: String? = null,
        credential: com.flagshipserver.app.api.BuildCredential? = null,
    ): Job = scope.launch {
        val id = buildId ?: return@launch
        _phase.value = GitPhase.Adapting
        try {
            val r = client.adapt(
                id,
                com.flagshipserver.app.api.BuildAdaptRequest(instructions = instructions, credential = credential),
            )
            _phase.value = GitPhase.Adapted(fileCount = r.fileCount)
        } catch (t: Throwable) {
            if (t is ScreensError.Http && t.status == 503) {
                _phase.value = GitPhase.AdaptUnavailable
            } else {
                _phase.value = GitPhase.Failed(friendly(t))
            }
        }
    }

    fun deploy(): Job = scope.launch {
        val id = buildId ?: return@launch
        _phase.value = GitPhase.Deploying
        // Surface this build in the global operations sliver while it runs.
        val target = operationTarget
        if (target != null) {
            operations?.upsertBuild(
                id = id,
                subject = serviceLabel ?: "a service",
                onServer = serverLabel,
                target = target,
            )
        }
        try {
            val r = client.deploy(id)
            _phase.value = GitPhase.Deployed(url = r.url)
        } catch (t: Throwable) {
            _phase.value = GitPhase.Failed(friendly(t))
        } finally {
            // Deployed, failed, or cancelled — drop the phantom op either way.
            operations?.removeBuild(id)
        }
    }

    fun reset() {
        buildId?.let { operations?.removeBuild(it) }
        buildId = null
        _phase.value = GitPhase.Idle
    }
}

// ---------- mcp mode ---------------------------------------------------

/**
 * MCP connect: "Create a connection" → URL + per-build key + copyable IDE
 * config + Regenerate + Deploy + the value-free env-requests list.
 */
class BuildMcpViewModel(
    private val client: BuildClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    sealed interface McpPhase {
        data object Idle : McpPhase
        data object Creating : McpPhase
        data object Ready : McpPhase
        data class Failed(val message: String) : McpPhase
    }

    private val _phase = MutableStateFlow<McpPhase>(McpPhase.Idle)
    val phase: StateFlow<McpPhase> = _phase.asStateFlow()

    private val _connection = MutableStateFlow<BuildMcpConnection?>(null)
    val connection: StateFlow<BuildMcpConnection?> = _connection.asStateFlow()

    private val _envRequests = MutableStateFlow<List<BuildEnvRequest>>(emptyList())
    val envRequests: StateFlow<List<BuildEnvRequest>> = _envRequests.asStateFlow()

    private val _deployStatus = MutableStateFlow<String?>(null)
    val deployStatus: StateFlow<String?> = _deployStatus.asStateFlow()

    var buildId: String? = null
        private set

    fun create(label: String = "android"): Job = scope.launch {
        _phase.value = McpPhase.Creating
        try {
            val r = client.mcpCreate(BuildMcpRequest(label = label))
            buildId = r.buildId
            _connection.value = r.connection
            _phase.value = McpPhase.Ready
            refreshEnvRequests().join()
        } catch (t: Throwable) {
            _phase.value = McpPhase.Failed(friendly(t))
        }
    }

    fun rotate(label: String = "android"): Job = scope.launch {
        val id = buildId ?: return@launch
        try {
            val r = client.mcpRotate(id, BuildMcpRequest(label = label))
            _connection.value = r.connection
        } catch (t: Throwable) {
            _phase.value = McpPhase.Failed(friendly(t))
        }
    }

    fun refreshEnvRequests(): Job = scope.launch {
        val id = buildId ?: return@launch
        try {
            _envRequests.value = client.envRequests(id).requests
        } catch (_: Throwable) {
            // Best-effort — leave the prior list in place.
        }
    }

    fun deploy(): Job = scope.launch {
        val id = buildId ?: return@launch
        _deployStatus.value = "deploying…"
        try {
            val r = client.deploy(id)
            _deployStatus.value = "Deployed → ${r.url}"
        } catch (t: Throwable) {
            _deployStatus.value = friendly(t)
        }
    }

    fun reset() {
        buildId = null
        _connection.value = null
        _envRequests.value = emptyList()
        _deployStatus.value = null
        _phase.value = McpPhase.Idle
    }
}

// ---------- journal ----------------------------------------------------

/**
 * Build journal viewer: a list of past builds → a per-build timeline.
 * Opening with a [buildId] jumps straight to the detail.
 */
class BuildJournalViewModel(
    private val client: BuildClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _list = MutableStateFlow<LoadingState<List<BuildSummary>>>(LoadingState.Idle)
    val list: StateFlow<LoadingState<List<BuildSummary>>> = _list.asStateFlow()

    private val _detail = MutableStateFlow<LoadingState<List<BuildJournalEntry>>>(LoadingState.Idle)
    val detail: StateFlow<LoadingState<List<BuildJournalEntry>>> = _detail.asStateFlow()

    fun loadList(): Job = scope.launch {
        _list.value = LoadingState.Loading
        try {
            _list.value = LoadingState.Loaded(client.sessions().builds)
        } catch (t: Throwable) {
            _list.value = LoadingState.Failed(friendly(t))
        }
    }

    fun loadDetail(buildId: String): Job = scope.launch {
        _detail.value = LoadingState.Loading
        try {
            _detail.value = LoadingState.Loaded(client.journal(buildId).entries)
        } catch (t: Throwable) {
            _detail.value = LoadingState.Failed(friendly(t))
        }
    }

    fun clearDetail() { _detail.value = LoadingState.Idle }
}
