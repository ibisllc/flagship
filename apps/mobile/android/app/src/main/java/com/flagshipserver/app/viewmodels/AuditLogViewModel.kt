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

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.UserErrorText
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
 *  which subsystem authored the event, and covering every kind the Worker
 *  writes. Unknown kinds are humanized rather than shown raw. Mirrors iOS
 *  AuditLogViewModel.label(for:). */
fun auditEventLabel(kind: String): String = when (kind) {
    "device-disconnected" -> FSStrings.get(R.string.disconnected_device)
    "device-replaced"     -> FSStrings.get(R.string.replaced_device)
    "device-added"        -> FSStrings.get(R.string.added_device)
    "wipe-restart"        -> FSStrings.get(R.string.wiped_restarted_account)
    "recovery-set-up"     -> FSStrings.get(R.string.set_up_recovery)
    "recovery-rotated"    -> FSStrings.get(R.string.rotated_recovery_passkey)
    "recovery-code-consumed" -> FSStrings.get(R.string.used_a_recovery_code)
    "app-renamed"         -> FSStrings.get(R.string.renamed_app_url)
    "server-created"      -> FSStrings.get(R.string.created_server)
    "server-online"       -> FSStrings.get(R.string.server_came_online)
    "server-migration-started"    -> FSStrings.get(R.string.started_moving_a_server)
    "server-migration-taken-over" -> FSStrings.get(R.string.moved_a_server_to_a_new)
    "server-migration-aborted"    -> FSStrings.get(R.string.cancelled_a_server_move)
    "server-revoked"      -> FSStrings.get(R.string.revoked_server)
    "server-unrevoked"    -> FSStrings.get(R.string.restored_server)
    "server-transfer-offered" -> FSStrings.get(R.string.offered_a_server_transfer)
    "server-transfer-claimed" -> FSStrings.get(R.string.server_transfer_claimed)
    "servers-self-delete-issued" -> FSStrings.get(R.string.requested_server_deletion)
    "demo-vps-provisioned" -> FSStrings.get(R.string.demo_server_provisioned)
    "totp-enrolled"       -> FSStrings.get(R.string.turned_on_authenticator_codes)
    "totp-disabled"       -> FSStrings.get(R.string.turned_off_authenticator_codes)
    "totp-failed-rate"    -> FSStrings.get(R.string.repeated_authenticator_code_failures)
    "re-pair-initiated"   -> FSStrings.get(R.string.started_device_replacement)
    "re-pair-expired"     -> FSStrings.get(R.string.device_replacement_expired)
    "re-pair-refused-no-credential" -> FSStrings.get(R.string.refused_a_device_replacement)
    "account-type-changed-single-to-multi" -> FSStrings.get(R.string.turned_on_code_protection)
    "account-type-changed-multi-to-single" -> FSStrings.get(R.string.switched_to_single_device)
    "ct-unexpected-cert"  -> FSStrings.get(R.string.unexpected_certificate_observed)
    "invite-created"      -> FSStrings.get(R.string.someone_was_invited_to_an_app)
    "account-deleted"     -> FSStrings.get(R.string.deleted_account)
    "username-reclaimed"  -> FSStrings.get(R.string.username_reclaimed)
    else -> kind.replace(Regex("[._-]+"), " ").trim()
        .ifEmpty { FSStrings.get(R.string.account_event) }
        .replaceFirstChar { it.uppercaseChar() }
}

/** The detail line to show under an event, or null. Some kinds record
 *  machine-oriented `key=value` detail that means nothing to a person.
 *  Mirrors iOS AuditLogViewModel.displayDetail(for:). */
fun auditEventDisplayDetail(event: AuditEvent): String? {
    val detail = event.detail.trim()
    if (detail.isEmpty()) return null
    if (event.eventKind == "demo-vps-provisioned") return null
    return detail
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
                    // The watch's "Recent activity" mirrors the feed (iOS does the same).
                    com.flagshipserver.app.companion.WatchBridge.publishEvents(
                        events.map {
                            com.flagshipserver.companion.SecurityAlert(it.seq, it.eventKind, it.detail, it.devicePrefix, it.postedAt)
                        },
                    )
                    _state.value = LoadingState.Loaded(AuditLogPage(events = events, canLoadMore = canLoadMore))
                },
                onFailure = { t ->
                    _state.value = LoadingState.Failed(UserErrorText.of(t, FSStrings.get(R.string.couldnt_load_the_activity_log_try)))
                },
            )
    }
}
