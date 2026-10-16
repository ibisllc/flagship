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
import com.flagshipserver.app.api.VibeCodeNameCheck
import com.flagshipserver.app.api.VibeCodeSessionMeta
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.NetworkErrorHumanizer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private fun friendly(t: Throwable): String = when (t) {
    is ScreensError.Http -> NetworkErrorHumanizer.humanize(t)
    is ScreensError -> t.message ?: "Something went wrong."
    else -> t.message ?: "Something went wrong."
}

/**
 * The build-a-service `/api/build` surface is mounted only when the box has
 * its service platform wired; when it isn't, the ENTIRE prefix 404s. So a 404
 * on a build ENTRY call (git "Check repo", MCP create, the build list) means
 * "this box can't build services", not "that thing was removed" — show the
 * truth instead of the generic 404 copy. Any other failure falls through to
 * [friendly]. Session-scoped 404s (a specific build journal id that's genuinely
 * gone) must NOT use this — they belong to [friendly].
 */
private fun friendlyBuildEntry(t: Throwable): String =
    if (t is ScreensError.Http && t.status == 404) {
        "This server isn't set up to build services yet. " +
            "Building services needs the services feature enabled on this box."
    } else {
        friendly(t)
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
    /** How often a background adapt is polled, and for how long at most. */
    private val pollIntervalMs: Long = 2_000,
    private val pollLimitMs: Long = 45 * 60 * 1_000L,
) {
    sealed interface GitPhase {
        data object Idle : GitPhase
        data object Checking : GitPhase
        /** Verdict in. `fit` true ⇒ deterministic install offer. */
        data class Verdict(val fit: Boolean, val reason: String, val fileCount: Int) : GitPhase
        /** `progress`: the AI's latest step, from the build's journal.
         *  `phase`: the box's "staging" | "going-live" (absent on older boxes). */
        data class Adapting(val progress: String? = null, val phase: String? = null) : GitPhase
        /** Adapt succeeded; ready to deploy. */
        data class Adapted(val fileCount: Int) : GitPhase
        data object Deploying : GitPhase
        data class Deployed(val url: String) : GitPhase
        /** The AI finished, but its tested app didn't go live: [reason] says
         *  why. A retry starts a new adapt on a new build. */
        data class NotLive(val reason: String) : GitPhase
        /** The build is closed to the AI (it was handed to the box to go
         *  live). Only a new build ("Check again") can use the AI. */
        data class Sealed(val message: String) : GitPhase
        /** The box has no model wired — caller should route to scratch. */
        data object AdaptUnavailable : GitPhase
        data class Failed(val message: String) : GitPhase
    }

    private val _phase = MutableStateFlow<GitPhase>(GitPhase.Idle)
    val phase: StateFlow<GitPhase> = _phase.asStateFlow()

    /** Set when "Check repo" was refused because the name is taken; the
     *  screen sends the owner to that build or asks for another name. */
    private val _conflict = MutableStateFlow<VibeCodeNameCheck?>(null)
    val conflict: StateFlow<VibeCodeNameCheck?> = _conflict.asStateFlow()

    /** The name the box will install it under, once the repo is checked. */
    private val _assignedName = MutableStateFlow<String?>(null)
    val assignedName: StateFlow<String?> = _assignedName.asStateFlow()

    /** A failed adapt, shown under the restored verdict so it can be retried. */
    private val _adaptError = MutableStateFlow<String?>(null)
    val adaptError: StateFlow<String?> = _adaptError.asStateFlow()

    /** Set once a repo is checked; reused by adapt/deploy. */
    var buildId: String? = null
        private set

    /** The not-ready card's "Anonymously share your adaptation" switch, sent
     *  with the adapt. It survives a failed adapt; a new check turns it on. */
    private val _share = MutableStateFlow(true)
    val share: StateFlow<Boolean> = _share.asStateFlow()

    private var lastVerdict: GitPhase.Verdict? = null

    /** The last "Check repo", replayed when a retry needs a new build. */
    private var lastRequest: BuildGitRequest? = null

    /** The current build refuses the AI from now on: an adapt starts a new one. */
    private var buildSealed = false

    fun dismissConflict() { _conflict.value = null }

    fun setShare(on: Boolean) { _share.value = on }

    fun checkRepo(gitUrl: String, ref: String, name: String = ""): Job = scope.launch {
        val wanted = slug(name)
        _conflict.value = null
        _assignedName.value = null
        _adaptError.value = null
        _exportError.value = null
        _share.value = true
        buildId = null
        buildSealed = false
        _phase.value = GitPhase.Checking
        try {
            val req = BuildGitRequest(
                gitUrl = gitUrl.trim(),
                ref = ref.trim().ifEmpty { null },
                name = wanted.ifEmpty { null },
            )
            lastRequest = req
            val r = client.gitImport(req)
            buildId = r.buildId
            _assignedName.value = r.name ?: wanted.ifEmpty { null }
            val v = GitPhase.Verdict(fit = r.fit, reason = r.reason, fileCount = r.fileCount)
            lastVerdict = v
            _phase.value = v
        } catch (t: Throwable) {
            val taken = VibeCodeNameCheck.conflict(t)
            if (taken != null) {
                _conflict.value = taken
                _phase.value = GitPhase.Idle
                return@launch
            }
            val reason = if (t is ScreensError.Http && (t.status == 400 || t.status == 422)) t.boxError() else null
            // A 404 here means the box has no build platform wired.
            _phase.value = GitPhase.Failed(reason ?: friendlyBuildEntry(t))
        }
    }

    fun adapt(
        instructions: String? = null,
        credential: com.flagshipserver.app.api.LlmProviderCredential? = null,
    ): Job = scope.launch {
        var id = buildId ?: return@launch
        _adaptError.value = null
        _phase.value = GitPhase.Adapting()
        if (buildSealed) id = reimport() ?: return@launch
        try {
            val r = client.adaptStart(
                id,
                com.flagshipserver.app.api.BuildAdaptRequest(
                    instructions = instructions, credential = credential, background = true,
                    share = _share.value,
                ),
            )
            if (r.started == true) {
                followAdaptWithLimit(id)
            } else {
                finishAdapt(r.fileCount ?: 0, r.deployed, r.deployedUrl, reason = null)
            }
        } catch (t: Throwable) {
            if (t is ScreensError.Http && t.status == 503) {
                _phase.value = GitPhase.AdaptUnavailable
            } else if (t is ScreensError.Http && t.status == 409 && closedToAi(t)) {
                buildSealed = true
                _phase.value = GitPhase.Sealed(t.boxError() ?: SEALED_TEXT)
            } else if (t is ScreensError.Http && t.status == 409) {
                // The box started the AI itself (a shared adaptation crashed
                // and it had a key): follow that run.
                try {
                    followAdaptWithLimit(id)
                } catch (e: Throwable) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    failAdapt(friendly(e))
                }
            } else {
                failAdapt(t.boxError() ?: friendly(t))
            }
        }
    }

    private suspend fun followAdaptWithLimit(id: String) {
        if (withTimeoutOrNull(pollLimitMs) { followAdapt(id) } == null) {
            failAdapt("The AI is taking unusually long. Check Build sessions later to see how it went.")
        }
    }

    /** Polls the build's state until the background adapt ends. A dropped
     *  poll (Wi-Fi blip, box restarting) isn't the end; five in a row are. */
    private suspend fun followAdapt(id: String) {
        var misses = 0
        var progress: String? = null
        while (true) {
            delay(pollIntervalMs)
            val state = try {
                client.state(id).state.also { misses = 0 }
            } catch (t: Throwable) {
                if (t is kotlinx.coroutines.CancellationException || ++misses >= 5) throw t
                continue
            }
            val status = state.adapt
            when (status?.status) {
                "done" -> {
                    if (state.sealed == true) buildSealed = true
                    finishAdapt(status.fileCount ?: 0, status.deployed, status.deployedUrl, status.reason)
                    return
                }
                "failed" -> {
                    if (state.sealed == true) buildSealed = true
                    failAdapt(status.reason ?: "The AI couldn't adapt this repo.")
                    return
                }
                else -> {
                    runCatching { client.journal(id).entries.lastOrNull() }.getOrNull()?.let { progress = it.summary }
                    _phase.value = GitPhase.Adapting(progress = progress, phase = status?.phase)
                }
            }
        }
    }

    private fun finishAdapt(fileCount: Int, deployed: Boolean?, deployedUrl: String?, reason: String?) {
        _phase.value = when {
            // The box put the AI's tested app live.
            deployed == true && deployedUrl != null -> GitPhase.Deployed(deployedUrl)
            // The tested app didn't go live; the build is closed to the AI now.
            deployed == false && !reason.isNullOrBlank() -> {
                buildSealed = true
                GitPhase.NotLive(reason)
            }
            // An older box: the AI only rewrote the repo, the owner installs it.
            else -> GitPhase.Adapted(fileCount)
        }
    }

    /** A new build from the last check, for an adapt the current build
     *  refuses. Returns its id, or null when it can't (or needs no AI). */
    private suspend fun reimport(): String? {
        val req = lastRequest ?: run {
            failAdapt(SEALED_TEXT)
            return null
        }
        return try {
            val r = client.gitImport(req)
            buildId = r.buildId
            buildSealed = false
            _assignedName.value = r.name ?: req.name
            val v = GitPhase.Verdict(fit = r.fit, reason = r.reason, fileCount = r.fileCount)
            lastVerdict = v
            if (r.fit) {
                _phase.value = v
                null
            } else {
                r.buildId
            }
        } catch (t: Throwable) {
            if (t is kotlinx.coroutines.CancellationException) throw t
            val taken = VibeCodeNameCheck.conflict(t)
            if (taken != null) {
                _conflict.value = taken
                _phase.value = lastVerdict ?: GitPhase.Idle
            } else {
                failAdapt(t.boxError() ?: friendly(t))
            }
            null
        }
    }

    private fun failAdapt(message: String) {
        // Restore the not-fit verdict so the user can retry the adapt.
        _adaptError.value = message
        _phase.value = lastVerdict ?: GitPhase.Failed(message)
    }

    fun deploy(): Job = scope.launch {
        val id = buildId ?: return@launch
        _phase.value = GitPhase.Deploying
        // Surface this build in the global operations sliver while it runs.
        // The tap target is the build's OWN surface — its journal timeline —
        // not the server detail (mirrors how scratch points at its chat).
        // [operationTarget] is an optional override; default to the journal.
        operations?.upsertBuild(
            id = id,
            subject = serviceLabel ?: "a service",
            onServer = serverLabel,
            target = operationTarget ?: com.flagshipserver.app.core.DeepLink.BuildJournal(id),
        )
        try {
            val r = client.deploy(id)
            _phase.value = GitPhase.Deployed(url = r.url)
        } catch (t: Throwable) {
            val reason = t.boxError() ?: friendly(t)
            // A shared adaptation that crashed here: the repo needs the
            // owner's AI now, so show the card that offers it.
            _phase.value = if (needsAdapt(t)) {
                GitPhase.Verdict(fit = false, reason = reason, fileCount = lastVerdict?.fileCount ?: 0)
                    .also { lastVerdict = it }
            } else {
                GitPhase.Failed(reason)
            }
        } finally {
            // Deployed, failed, or cancelled — drop the phantom op either way.
            operations?.removeBuild(id)
        }
    }

    /** Set once the flagship.app.json for this repo is written, ready to share. */
    private val _adapterFile = MutableStateFlow<java.io.File?>(null)
    val adapterFile: StateFlow<java.io.File?> = _adapterFile.asStateFlow()

    private val _exportingAdapter = MutableStateFlow(false)
    val exportingAdapter: StateFlow<Boolean> = _exportingAdapter.asStateFlow()

    private val _exportError = MutableStateFlow<String?>(null)
    val exportError: StateFlow<String?> = _exportError.asStateFlow()

    /** Fetch the file that makes this repo run the way this build does, and
     *  save it as `<dir>/<build>/flagship.app.json` for the share sheet. */
    fun exportAdapter(dir: java.io.File): Job? {
        val id = buildId ?: return null
        if (_exportingAdapter.value) return null
        _exportingAdapter.value = true
        _exportError.value = null
        return scope.launch {
            try {
                val text = client.adapterFile(id)
                val buildDir = java.io.File(dir, id.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.ifEmpty { "build" })
                buildDir.mkdirs()
                val file = java.io.File(buildDir, ADAPTER_FILE_NAME)
                file.writeText(text)
                _adapterFile.value = file
            } catch (t: Throwable) {
                _exportError.value = t.boxError() ?: friendly(t)
            } finally {
                _exportingAdapter.value = false
            }
        }
    }

    /** The share sheet has the file; don't offer it again on recomposition. */
    fun adapterFileShared() { _adapterFile.value = null }

    fun reset() {
        buildId?.let { operations?.removeBuild(it) }
        buildId = null
        lastVerdict = null
        lastRequest = null
        buildSealed = false
        _adapterFile.value = null
        _exportError.value = null
        _conflict.value = null
        _assignedName.value = null
        _adaptError.value = null
        _share.value = true
        _phase.value = GitPhase.Idle
    }

    companion object {
        const val ADAPTER_FILE_NAME = "flagship.app.json"
        const val NOT_READY_MISSING = "This repo is not yet adapted for Flagship."
        const val ADAPT_BUTTON = "Use AI to adapt and deploy"
        const val ADAPTING_DEFAULT = "The AI is adapting the repo…"
        const val ADAPTING_STAGING = "The AI is adapting and testing the app on a private copy with sample data…"
        const val ADAPTING_GOING_LIVE = "Installing the tested app…"
        const val NOT_LIVE_TITLE = "The app didn't go live"
        const val RETRY_ADAPT = "Try again with AI"
        const val SEALED_TEXT = "This build is closed to the AI. Check the repo again to start a new build."
        const val SHARE_LABEL = "Anonymously share your adaptation"
        const val SHARE_NOTE = "Others can then install this repo without AI. Nothing about you or your server is included."
        const val CHECK_AGAIN = "Check again"
        const val RUN_AI_AGAIN = "Run the AI again"
        const val DEPLOY = "Deploy"

        /** A box restart cut the AI's work (or the box putting the build
         *  live) off: its files are kept, so the build can be deployed as it
         *  is, or the AI run again. The box's sentences (buildOrchestrator.ts
         *  INTERRUPTED_AI_REASON / INTERRUPTED_GO_LIVE_REASON). */
        fun interrupted(reason: String?): Boolean = reason?.contains("restarted while", ignoreCase = true) == true

        /** A verdict card (and the not-live and closed cards) takes the
         *  "Check repo" button's place; each carries its own "Check again". */
        fun showsCheckRepo(phase: GitPhase): Boolean =
            phase !is GitPhase.Verdict && phase !is GitPhase.NotLive && phase !is GitPhase.Sealed

        /** The adapting card's headline for the box's `adapt.phase`. */
        fun adaptingHeadline(phase: String?): String = when (phase) {
            "staging" -> ADAPTING_STAGING
            "going-live" -> ADAPTING_GOING_LIVE
            else -> ADAPTING_DEFAULT
        }

        /** The box's 409 for a build it has closed to the AI. */
        fun closedToAi(t: Throwable): Boolean =
            t is ScreensError.Http && t.status == 409 &&
                (t.boxError() ?: t.body).contains("closed to the AI", ignoreCase = true)

        /** A deploy refusal that says the repo now needs the owner's AI. */
        fun needsAdapt(t: Throwable): Boolean {
            if (t !is ScreensError.Http) return false
            val obj = runCatching { Json.parseToJsonElement(t.body) as? JsonObject }.getOrNull() ?: return false
            return (obj["needsAdapt"] as? JsonPrimitive)?.let { !it.isString && it.content == "true" } == true
        }

        /** The typed name as the address label it becomes. */
        fun slug(name: String): String = name.lowercase().filter { it.isLetterOrDigit() || it == '-' }

        /** A repo without a manifest gets the plain sentence; a broken manifest
         *  keeps the box's reason, which says what is wrong with it. */
        fun notReadyText(reason: String): String =
            if (reason.startsWith("no flagship.app.json")) {
                NOT_READY_MISSING
            } else {
                reason
            }

        /** The label the address will have: the typed name, the one the box
         *  chose, or a stand-in until the repo is checked. */
        fun addressLabel(slug: String, assigned: String?): String = slug.ifEmpty { assigned ?: "<repo name>" }

        /** The muted hint under a blank name. */
        fun blankNameHint(ref: String): String =
            "Leave it blank to name it after the repo${if (ref.isBlank()) "" else " and branch"}."
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
    /** Set when the IDE changes an installed service rather than building a
     *  new one: the build starts from its code and deploys over it. */
    val editServiceId: String? = null,
) {
    /** The slug of the service being edited, for the intro line. */
    val editingName: String? get() = editServiceId?.substringAfter("--")

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
            val r = client.mcpCreate(BuildMcpRequest(label = label, editServiceId = editServiceId))
            buildId = r.buildId
            _connection.value = r.connection
            _phase.value = McpPhase.Ready
            refreshEnvRequests().join()
        } catch (t: Throwable) {
            // A 404 on this entry call means the box has no build platform;
            // an edit's refusals (service gone, not editable) carry their own words.
            val boxSays = if (editServiceId != null) t.boxError() else null
            _phase.value = McpPhase.Failed(boxSays ?: friendlyBuildEntry(t))
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
 * Build sessions: the sessions the box still holds (resumable) above the
 * past builds, each of which opens a per-build timeline. Opening with a
 * [buildId] jumps straight to the detail.
 */
class BuildJournalViewModel(
    private val client: BuildClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val fetchLiveSessions: suspend () -> List<VibeCodeSessionMeta> = { emptyList() },
    private val discardSession: suspend (String) -> Unit = { throw ScreensError.NotImplemented("discard") },
    /** Every server this device can ask (the webapp's fetchBuildsOnServers):
     *  the list then covers builds started on any of them. Empty: only
     *  [client] / [fetchLiveSessions], the server the screen is on. */
    private val servers: () -> List<Server> = { emptyList() },
    private val pollIntervalMs: Long = 3_000,
) {
    /** What the detail page offers for the build's own state: an AI adapt
     *  that failed (a box restart brings an interrupted one back failed,
     *  with the box's sentence) can be deployed as it is or run again. */
    sealed interface DetailAdapt {
        data object None : DetailAdapt
        data class Failed(val reason: String, val canRunAi: Boolean) : DetailAdapt
        data class Working(val text: String) : DetailAdapt
        data class Adapted(val fileCount: Int) : DetailAdapt
        data class Deployed(val url: String) : DetailAdapt
    }

    private val _detailAdapt = MutableStateFlow<DetailAdapt>(DetailAdapt.None)
    val detailAdapt: StateFlow<DetailAdapt> = _detailAdapt.asStateFlow()

    /** One server's own clients, for the list across servers. */
    class Server(
        val podId: String,
        val name: String,
        val build: BuildClient,
        val fetchLiveSessions: suspend () -> List<VibeCodeSessionMeta>,
        val discardSession: suspend (String) -> Unit,
    )

    private var sessionServer: Map<String, Server> = emptyMap()
    private var buildServer: Map<String, Server> = emptyMap()

    /** Servers whose builds couldn't be read (named under the list). */
    private val _failedServers = MutableStateFlow<List<String>>(emptyList())
    val failedServers: StateFlow<List<String>> = _failedServers.asStateFlow()

    /** Whether the list spans more than one server (rows then name theirs). */
    private val _multiServer = MutableStateFlow(false)
    val multiServer: StateFlow<Boolean> = _multiServer.asStateFlow()

    /** The server a session or build row lives on; null on a one-server list. */
    fun serverOfSession(sessionId: String): Server? = sessionServer[sessionId]
    fun serverOfBuild(buildId: String): Server? = buildServer[buildId]

    private val _list = MutableStateFlow<LoadingState<List<BuildSummary>>>(LoadingState.Idle)
    val list: StateFlow<LoadingState<List<BuildSummary>>> = _list.asStateFlow()

    private val _detail = MutableStateFlow<LoadingState<List<BuildJournalEntry>>>(LoadingState.Idle)
    val detail: StateFlow<LoadingState<List<BuildJournalEntry>>> = _detail.asStateFlow()

    /** Every chat the box holds (finished and failed ones too, for 30 days),
     *  newest activity first. Their journals stay in [list]. */
    private val _liveSessions = MutableStateFlow<List<VibeCodeSessionMeta>>(emptyList())
    val liveSessions: StateFlow<List<VibeCodeSessionMeta>> = _liveSessions.asStateFlow()

    fun loadList(): Job = scope.launch {
        val all = servers()
        if (all.isNotEmpty()) return@launch loadAcross(all)
        _list.value = LoadingState.Loading
        val sessions = async { runCatching { fetchLiveSessions() }.getOrDefault(emptyList()) }
        try {
            val builds = client.sessions().builds
            _liveSessions.value = BuildSessions.newestFirst(sessions.await())
            _list.value = LoadingState.Loaded(builds)
        } catch (t: Throwable) {
            sessions.cancel()
            // The sessions list is a build-platform ENTRY call — a 404 means the
            // box can't build services (unlike loadDetail's session-scoped 404).
            _list.value = LoadingState.Failed(friendlyBuildEntry(t))
        }
    }

    private suspend fun loadAcross(all: List<Server>) {
        _list.value = LoadingState.Loading
        _multiServer.value = all.size > 1
        class Result(val server: Server, val builds: List<BuildSummary>?, val sessions: List<VibeCodeSessionMeta>, val error: Throwable?)
        val results = kotlinx.coroutines.coroutineScope {
            all.map { srv ->
                async {
                    val sessions = async { runCatching { srv.fetchLiveSessions() }.getOrDefault(emptyList()) }
                    val builds = runCatching { srv.build.sessions().builds }
                    Result(srv, builds.getOrNull(), sessions.await(), builds.exceptionOrNull())
                }
            }.map { it.await() }
        }
        sessionServer = results.flatMap { r -> r.sessions.map { it.sessionId to r.server } }.toMap()
        buildServer = results.flatMap { r -> r.builds.orEmpty().map { it.buildId to r.server } }.toMap()
        _failedServers.value = results.filter { it.error != null }.map { it.server.name }
        val ok = results.filter { it.builds != null }
        if (ok.isEmpty()) {
            _list.value = LoadingState.Failed(friendlyBuildEntry(results.firstNotNullOf { it.error }))
            return
        }
        _liveSessions.value = BuildSessions.newestFirst(results.flatMap { it.sessions })
        _list.value = LoadingState.Loaded(ok.flatMap { it.builds.orEmpty() }.sortedByDescending { it.startedAt })
    }

    fun loadDetail(buildId: String): Job = scope.launch {
        _detail.value = LoadingState.Loading
        try {
            _detail.value = LoadingState.Loaded(client.journal(buildId).entries)
        } catch (t: Throwable) {
            _detail.value = LoadingState.Failed(friendly(t))
        }
        // Best-effort: an older box (or a scratch build) has no state route.
        val state = try {
            client.state(buildId).state
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        val adapt = state?.adapt
        _detailAdapt.value = if (adapt?.status == "failed" && !adapt.reason.isNullOrBlank()) {
            DetailAdapt.Failed(adapt.reason, canRunAi = state.sealed != true)
        } else {
            DetailAdapt.None
        }
    }

    /** Put the build live as it is (its files survived the restart). */
    fun deployAgain(buildId: String): Job = scope.launch {
        val before = _detailAdapt.value
        _detailAdapt.value = DetailAdapt.Working("Installing…")
        try {
            _detailAdapt.value = DetailAdapt.Deployed(client.deploy(buildId).url)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (t: Throwable) {
            _detailAdapt.value = DetailAdapt.Failed(t.boxError() ?: friendly(t), canRunAi = (before as? DetailAdapt.Failed)?.canRunAi ?: false)
        }
    }

    /** Run the AI on the build again with [credential], and follow it. */
    fun runAiAgain(buildId: String, credential: com.flagshipserver.app.api.LlmProviderCredential?): Job = scope.launch {
        _detailAdapt.value = DetailAdapt.Working(BuildGitViewModel.ADAPTING_DEFAULT)
        try {
            val r = client.adaptStart(buildId, com.flagshipserver.app.api.BuildAdaptRequest(credential = credential, background = true))
            if (r.started != true) {
                _detailAdapt.value = adaptEnded(r.fileCount ?: 0, r.deployed, r.deployedUrl, null)
                return@launch
            }
            var misses = 0
            while (true) {
                delay(pollIntervalMs)
                val st = try {
                    client.state(buildId).state.also { misses = 0 }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (t: Throwable) {
                    if (++misses >= 5) throw t
                    continue
                }
                val a = st.adapt
                when (a?.status) {
                    "done" -> {
                        _detailAdapt.value = adaptEnded(a.fileCount ?: 0, a.deployed, a.deployedUrl, a.reason)
                        return@launch
                    }
                    "failed" -> {
                        _detailAdapt.value = DetailAdapt.Failed(a.reason ?: "The AI couldn't adapt this repo.", canRunAi = st.sealed != true)
                        return@launch
                    }
                    else -> _detailAdapt.value = DetailAdapt.Working(BuildGitViewModel.adaptingHeadline(a?.phase))
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (t: Throwable) {
            _detailAdapt.value = DetailAdapt.Failed(t.boxError() ?: friendly(t), canRunAi = !(t is ScreensError.Http && t.status == 409))
        }
    }

    private fun adaptEnded(fileCount: Int, deployed: Boolean?, url: String?, reason: String?): DetailAdapt = when {
        deployed == true && url != null -> DetailAdapt.Deployed(url)
        deployed == false && !reason.isNullOrBlank() -> DetailAdapt.Failed(reason, canRunAi = false)
        else -> DetailAdapt.Adapted(fileCount)
    }

    fun clearDetail() { _detail.value = LoadingState.Idle }

    private val _discardError = MutableStateFlow<String?>(null)
    val discardError: StateFlow<String?> = _discardError.asStateFlow()

    /** Stop a session and delete it on the box, which frees its name. */
    fun discard(session: VibeCodeSessionMeta): Job = scope.launch {
        _discardError.value = null
        try {
            (sessionServer[session.sessionId]?.discardSession ?: discardSession)(session.sessionId)
            _liveSessions.value = _liveSessions.value.filterNot { it.sessionId == session.sessionId }
        } catch (t: Throwable) {
            _discardError.value = t.userFacing()
        }
    }

    /** Forget an open git or IDE build on the box, which frees its name. */
    fun discard(build: BuildSummary): Job = scope.launch {
        _discardError.value = null
        try {
            (buildServer[build.buildId]?.build ?: client).discard(build.buildId)
            loadList().join()
        } catch (t: Throwable) {
            _discardError.value = t.boxError() ?: t.userFacing()
        }
    }
}

/** Pure parts of the build sessions screen. Mirror of iOS BuildJournalScreen /
 *  BuildJournalViewModel and the webapp lib/vibeSessions.js. */
object BuildSessions {
    /** The servers the build list asks: each live server this device has a
     *  session on, once per box (mock mode hands every pod the same clients). */
    fun servers(pods: List<com.flagshipserver.app.core.PodInfo>, clients: com.flagshipserver.app.core.PodClients): List<BuildJournalViewModel.Server> =
        pods.filter { !it.isRevoked && it.status != com.flagshipserver.app.core.PodInfo.Status.PENDING }
            .mapNotNull { pod ->
                val build = clients.build(pod) ?: return@mapNotNull null
                val screens = clients.screens(pod) ?: return@mapNotNull null
                BuildJournalViewModel.Server(
                    podId = pod.podId,
                    name = pod.name,
                    build = build,
                    fetchLiveSessions = { screens.vibeCodeSessions().sessions },
                    discardSession = { screens.vibeCodeDiscard(it) },
                ) to build
            }
            .distinctBy { System.identityHashCode(it.second) }
            .map { it.first }

    /** The line under the list naming servers whose builds couldn't be read. */
    fun unreadServersLine(names: List<String>): String =
        "Couldn't read builds on ${names.joinToString(", ")}."

    /** Past builds the box no longer holds a session for. */
    fun endedBuilds(builds: List<BuildSummary>, sessions: List<VibeCodeSessionMeta>): List<BuildSummary> {
        val live = sessions.mapTo(HashSet()) { it.sessionId }
        return builds.filter { it.buildId !in live && it.open != true }
    }

    /** Git imports and IDE builds the box still holds (and whose names it keeps). */
    fun openBuilds(builds: List<BuildSummary>, sessions: List<VibeCodeSessionMeta>): List<BuildSummary> {
        val live = sessions.mapTo(HashSet()) { it.sessionId }
        return builds.filter { it.open == true && it.buildId !in live }
    }

    /** A live session's title: its own name, else its journal build's, else
     *  its service's slug. */
    fun name(session: VibeCodeSessionMeta, builds: List<BuildSummary>): String =
        session.name
            ?: builds.firstOrNull { it.buildId == session.sessionId }?.displayName
            ?: session.serviceId?.substringAfterLast("--")
            ?: "Unnamed build"

    /** "Started <time> · N step(s)" under a past build's name. */
    fun pastBuildSubtitle(build: BuildSummary, started: String): String =
        "Started $started · ${build.entryCount} step${if (build.entryCount == 1) "" else "s"}"

    const val DISCARD_TITLE = "Discard this build?"

    fun discardBuildMessage(build: BuildSummary): String =
        "This deletes what was imported or written on your server. Its name, \"${build.displayName}\", becomes free again."

    fun discardMessage(session: VibeCodeSessionMeta): String {
        val freed = session.name?.let { " Its name, \"$it\", becomes free again." } ?: ""
        return "This stops the AI and deletes what it has written on your server.$freed"
    }

    fun label(status: String): String = when (status) {
        "streaming" -> "AI is working"
        "awaiting-tool-response" -> "Waiting for you"
        "ready-to-deploy" -> "Ready to deploy"
        "deploying" -> "Deploying"
        "deployed" -> "Deployed"
        "failed" -> "Failed"
        "cancelled" -> "Cancelled"
        else -> "Stopped"
    }

    /** The row's action: the owner can write to it, it's still running, or it's done. */
    fun action(status: String): String = when (status) {
        "awaiting-tool-response", "ready-to-deploy", "failed" -> "Continue"
        "streaming", "deploying" -> "Resume"
        else -> "Open"
    }

    /** Newest activity first: the last change, else when it started. */
    fun newestFirst(sessions: List<VibeCodeSessionMeta>): List<VibeCodeSessionMeta> =
        sessions.sortedByDescending { it.updatedAt ?: it.startedAt }
}
