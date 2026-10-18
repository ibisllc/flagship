// Kotlin mirror of FlagshipUI/ViewModels/AppsListViewModel.swift.
//
// Asks every one of the account's servers for its apps list, over that
// server's own session (the same lookup as Runs on, docs/app-placement.md §4),
// and lists each app once with the pill combining every server it is on (§6).
// Then fans out a per-service /api/users/:u/apps/:serviceId/links fetch (#20):
// the list paints as soon as the servers answer, and each row's voi.ci short
// URL and canonical FQDN fill in as the /links results
// land. Per-service failure is tolerated (one row's .com blip must not nuke
// the whole list) — exactly the iOS behavior.
//
// When the contract changes, update this file AND
// apps/mobile/ios/Sources/FlagshipUI/ViewModels/AppsListViewModel.swift
// in the same commit.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.UserErrorText
import com.flagshipserver.app.api.AppLinksResponse
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.AppStatus
import com.flagshipserver.app.core.PodApps
import com.flagshipserver.app.core.PodInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ServicesListViewModel(
    /** The current server's client: used alone when there are no servers to ask. */
    private val client: ScreensClient,
    private val server: FlagshipServerClient?,
    private val username: () -> String?,
    /** The account's servers. */
    private val pods: () -> List<PodInfo> = { emptyList() },
    /** A screens client bound to one server's session, or null without one. */
    private val clientFor: (PodInfo) -> ScreensClient? = { null },
    /** The server whose copy of an app describes it in the list (the current one). */
    private val preferredPodId: () -> String? = { null },
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    /** One app, once, with the servers it is on and its combined pill. */
    data class Listed(
        val app: AppSummary,
        /** The servers that list the app (this time or, if unreachable now, last time). */
        val podIds: List<String>,
        val pill: AppStatus.Pill,
        /** Some server has a host waiting for the owner's answer. */
        val egressPending: Boolean = false,
    )

    private val _state = MutableStateFlow<LoadingState<List<Listed>>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<List<Listed>>> = _state.asStateFlow()

    /** Per-service links cache, keyed by serviceId. Absent means still
     *  loading or .com unreachable for that row; the row falls back
     *  to the daemon-provided URL. Mirrors iOS `linksByServiceId`. */
    private val _linksByServiceId = MutableStateFlow<Map<String, AppLinksResponse>>(emptyMap())
    val linksByServiceId: StateFlow<Map<String, AppLinksResponse>> = _linksByServiceId.asStateFlow()

    /** Each server's apps when it last answered, so an app on a server that
     *  stops answering stays listed as "Can't reach" rather than vanishing. */
    private val lastKnown = HashMap<String, List<AppSummary>>()

    fun load() = scope.launch { refresh() }

    suspend fun refresh() {
        if (_state.value !is LoadingState.Loaded) _state.value = LoadingState.Loading
        val servers = PodApps.servers(pods())
        val listed = try {
            if (servers.isEmpty()) single() else across(servers)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (t: Throwable) {
            _state.value = LoadingState.Failed(UserErrorText.of(t, "Couldn't load your apps. Try again."))
            return
        }
        if (listed == null) {
            _state.value = LoadingState.Failed(CANT_REACH)
            return
        }
        _state.value = LoadingState.Loaded(listed)
        // Kick off the link fan-out — rows paint immediately and
        // the URLs fill in as each result arrives.
        loadLinks(listed.map { it.app }.filter { it.serviceId !in _linksByServiceId.value })
    }

    /** No servers known yet: the current server's list alone. With no
     *  server paired at all (a new account) there is nothing to list, never
     *  an error: the screen says to add a server first. */
    private suspend fun single(): List<Listed> {
        val apps = try {
            client.appsList().apps
        } catch (e: com.flagshipserver.app.api.ScreensError) {
            if (e is com.flagshipserver.app.api.ScreensError.NotPaired ||
                e is com.flagshipserver.app.api.ScreensError.NoSessionToken
            ) return emptyList()
            throw e
        }
        return apps.map {
            Listed(it, emptyList(), AppStatus.combined(listOf(AppStatus.of(it))), AppAccessViewModel.showsBadge(it))
        }
    }

    /** Null when no server answered and none had answered before. */
    private suspend fun across(servers: List<PodInfo>): List<Listed>? {
        val preferred = preferredPodId()
        val ordered = servers.sortedBy { if (it.podId == preferred) 0 else 1 }
        val answers = PodApps.askAll(ordered, clientFor)
        val perServer = answers.mapNotNull { (pod, answer) ->
            when (answer) {
                is PodApps.Answer.Listed -> {
                    lastKnown[pod.podId] = answer.apps
                    ServerApps(pod.podId, answer.apps, answered = true)
                }
                else -> lastKnown[pod.podId]?.let { ServerApps(pod.podId, it, answered = false) }
            }
        }
        if (perServer.isEmpty()) return null
        return combine(perServer)
    }

    /** One server's apps; [answered] false when they are what it said last time. */
    data class ServerApps(val podId: String, val apps: List<AppSummary>, val answered: Boolean)

    /** V2 — fan-out fetch of /api/users/:u/apps/:serviceId/links per
     *  service. Tolerates per-service failure without nuking the list;
     *  updates `linksByServiceId` as each result lands. */
    private suspend fun loadLinks(apps: List<AppSummary>) = coroutineScope {
        val srv = server ?: return@coroutineScope
        val user = username()?.takeIf { it.isNotEmpty() } ?: return@coroutineScope
        val deferred = apps.map { app ->
            async {
                try {
                    app.serviceId to srv.getAppLinks(user, app.serviceId)
                } catch (t: Throwable) {
                    app.serviceId to null
                }
            }
        }
        for (d in deferred) {
            val (serviceId, links) = d.await()
            if (links != null) {
                _linksByServiceId.value = _linksByServiceId.value + (serviceId to links)
            }
        }
    }

    companion object {
        const val CANT_REACH = "Can't reach your servers right now."

        /** Each app once, in the order the servers list them (the first
         *  server's copy describes it), with the pill over every server it is
         *  on. A server's state counts only when it [ServerApps.answered]. */
        fun combine(servers: List<ServerApps>): List<Listed> {
            val order = LinkedHashMap<String, AppSummary>()
            val on = HashMap<String, MutableList<Pair<String, AppStatus.ServerState?>>>()
            val pending = HashSet<String>()
            for (s in servers) {
                for (app in s.apps) {
                    order.putIfAbsent(app.serviceId, app)
                    if (AppAccessViewModel.showsBadge(app)) pending.add(app.serviceId)
                    on.getOrPut(app.serviceId) { mutableListOf() }
                        .add(s.podId to if (s.answered) AppStatus.of(app) else null)
                }
            }
            return order.map { (id, app) ->
                val entries = on[id].orEmpty()
                Listed(
                    app = app,
                    podIds = entries.map { it.first }.distinct(),
                    pill = AppStatus.combined(entries.map { it.second }),
                    egressPending = id in pending,
                )
            }
        }
    }
}
