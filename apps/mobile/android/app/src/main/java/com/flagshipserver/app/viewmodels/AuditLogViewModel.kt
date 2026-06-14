// P5 — dedicated audit-log viewer.
//
// Pages the account-level audit feed off .com
// (FlagshipServerClient.listAuditEvents → GET /api/users/:u/audit).
// Mirrors webapp views/audit-log.js (the full-page list). The Worker's
// `since` is an EXCLUSIVE LOWER bound that returns the newest `limit`
// rows (ORDER BY seq DESC, capped at 50), so "load more" grows the
// requested window rather than walking a cursor — the only paging the
// endpoint supports. The kind→label map mirrors docs/revocation-ui.md.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AuditEvent
import com.flagshipserver.app.api.FlagshipServerClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Server-side cap on `limit` (packages/control-plane/src/auditEvents.ts
 *  MAX_LIMIT). Once the window reaches this, no further events can be
 *  fetched through this endpoint and the "load more" affordance hides. */
const val AUDIT_LOG_MAX_WINDOW = 50
const val AUDIT_LOG_PAGE_SIZE = 20

/** Human-readable label for each audit event kind. Pinned to
 *  docs/revocation-ui.md so the log reads consistently regardless of
 *  which subsystem authored the event. Mirrors the iOS + webapp maps. */
fun auditEventLabel(kind: String): String = when (kind) {
    "device-disconnected" -> "Disconnected device"
    "device-replaced"     -> "Replaced device"
    "device-added"        -> "Added device"
    "wipe-restart"        -> "Wiped & restarted account"
    "recovery-set-up"     -> "Set up recovery"
    "recovery-rotated"    -> "Rotated recovery passkey"
    "app-renamed"         -> "Renamed app URL"
    "server-created"      -> "Created server"
    "server-online"       -> "Server came online"
    else                  -> kind
}

data class AuditLogPage(
    val events: List<AuditEvent>,
    /** True while the server might hold more rows than we've fetched —
     *  i.e. the last fetch filled the requested window AND the window is
     *  still below the server's hard cap. */
    val canLoadMore: Boolean,
    /** True while a load-more fetch is in flight (the first-page fetch
     *  uses LoadingState.Loading instead). */
    val loadingMore: Boolean = false,
)

class AuditLogViewModel(
    private val client: FlagshipServerClient,
    private val username: () -> String?,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _state = MutableStateFlow<LoadingState<AuditLogPage>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<AuditLogPage>> = _state.asStateFlow()

    private var window = AUDIT_LOG_PAGE_SIZE

    /** Initial load (or pull-to-refresh): reset the window + fetch the
     *  newest page. */
    fun load() = scope.launch {
        window = AUDIT_LOG_PAGE_SIZE
        _state.value = LoadingState.Loading
        fetch()
    }

    /** Grow the window by one page + re-fetch. No-op if a fetch is in
     *  flight or the window already hit the server cap. */
    fun loadMore() = scope.launch {
        val current = _state.value
        if (current !is LoadingState.Loaded || !current.value.canLoadMore || current.value.loadingMore) {
            return@launch
        }
        window = (window + AUDIT_LOG_PAGE_SIZE).coerceAtMost(AUDIT_LOG_MAX_WINDOW)
        _state.value = LoadingState.Loaded(current.value.copy(loadingMore = true))
        fetch()
    }

    private suspend fun fetch() {
        val u = username()
        if (u.isNullOrEmpty()) {
            _state.value = LoadingState.Loaded(AuditLogPage(events = emptyList(), canLoadMore = false))
            return
        }
        runCatching { client.listAuditEvents(u, sinceSeq = 0, limit = window).events }
            .fold(
                onSuccess = { events ->
                    val canLoadMore = events.size >= window && window < AUDIT_LOG_MAX_WINDOW
                    _state.value = LoadingState.Loaded(AuditLogPage(events = events, canLoadMore = canLoadMore))
                },
                onFailure = { t ->
                    _state.value = LoadingState.Failed(t.message ?: "couldn't load the audit log")
                },
            )
    }
}
