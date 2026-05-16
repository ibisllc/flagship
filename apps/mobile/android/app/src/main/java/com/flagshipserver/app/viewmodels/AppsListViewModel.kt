// Kotlin mirror of FlagshipUI/ViewModels/AppsListViewModel.swift.
//
// Loads the daemon's paired-session apps-list, then fans out a
// per-app /api/users/:u/apps/:appId/links fetch (#20). The list
// paints as soon as appsList() returns; each row's voi.ci short URL,
// canonical FQDN and bound custom domain fill in as the /links
// results land. Per-app failure is tolerated (one row's .com blip
// must not nuke the whole list) — exactly the iOS behavior.
//
// When the contract changes, update this file AND
// apps/mobile/ios/Sources/FlagshipUI/ViewModels/AppsListViewModel.swift
// in the same commit.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppLinksResponse
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ScreensClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class AppsListViewModel(
    private val client: ScreensClient,
    private val server: FlagshipServerClient?,
    private val username: () -> String?,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _state = MutableStateFlow<LoadingState<List<AppSummary>>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<List<AppSummary>>> = _state.asStateFlow()

    /** Per-app links cache, keyed by appId. Absent means still
     *  loading or .com unreachable for that row; the row falls back
     *  to the daemon-provided URL. Mirrors iOS `linksByAppId`. */
    private val _linksByAppId = MutableStateFlow<Map<String, AppLinksResponse>>(emptyMap())
    val linksByAppId: StateFlow<Map<String, AppLinksResponse>> = _linksByAppId.asStateFlow()

    fun load() = scope.launch {
        _state.value = LoadingState.Loading
        try {
            val resp = client.appsList()
            _state.value = LoadingState.Loaded(resp.apps)
            // Kick off the link fan-out — rows paint immediately and
            // the URLs fill in as each result arrives.
            loadLinks(resp.apps)
        } catch (t: Throwable) {
            _state.value = LoadingState.Failed(t.message ?: "couldn't load apps")
        }
    }

    /** V2 — fan-out fetch of /api/users/:u/apps/:appId/links per app.
     *  Tolerates per-app failure without nuking the list; updates
     *  `linksByAppId` as each result lands. */
    private suspend fun loadLinks(apps: List<AppSummary>) = coroutineScope {
        val srv = server ?: return@coroutineScope
        val user = username()?.takeIf { it.isNotEmpty() } ?: return@coroutineScope
        val deferred = apps.map { app ->
            async {
                try {
                    app.appId to srv.getAppLinks(user, app.appId)
                } catch (t: Throwable) {
                    app.appId to null
                }
            }
        }
        for (d in deferred) {
            val (appId, links) = d.await()
            if (links != null) {
                _linksByAppId.value = _linksByAppId.value + (appId to links)
            }
        }
    }
}
