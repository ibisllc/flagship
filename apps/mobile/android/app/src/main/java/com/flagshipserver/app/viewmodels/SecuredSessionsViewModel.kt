// "Open secured sessions" manager (docs/service-access-gating.md,
// "Web-experience gating"). Lists the browser QR-login sessions this phone
// authorized (from SecuredSessionStore), lets the user Refresh a row's
// online/offline (rate-limited ~1/min/secretId by the box — debounced ≥60s
// client-side too; a 429 keeps the last-known state) and Stop a session (closes
// it on the box, then drops it from the store).

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.SecuredSession
import com.flagshipserver.app.core.SecuredSessionStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Per-session liveness as the user has most recently observed it. */
enum class SessionLiveness { UNKNOWN, ONLINE, OFFLINE }

data class SecuredSessionRow(
    val session: SecuredSession,
    val liveness: SessionLiveness = SessionLiveness.UNKNOWN,
    /** Last time we successfully queried (ms); drives the ≥60s debounce. */
    val lastCheckedAt: Long? = null,
    val refreshing: Boolean = false,
)

class SecuredSessionsViewModel(
    private val client: ServiceAccessClient = ServiceAccessClient(),
    private val now: () -> Long = { System.currentTimeMillis() },
    private val load: () -> List<SecuredSession> = { SecuredSessionStore.list() },
    private val removeFromStore: (String) -> Unit = { SecuredSessionStore.remove(it) },
) : ViewModel() {
    /** Client-side status debounce; mirror of the box's ~1/min rate limit. */
    private val refreshDebounceMs = 60_000L

    private val _rows = MutableStateFlow<List<SecuredSessionRow>>(emptyList())
    val rows: StateFlow<List<SecuredSessionRow>> = _rows.asStateFlow()

    /** (Re)load the persisted sessions, preserving any liveness already observed. */
    fun reload() {
        val prior = _rows.value.associateBy { it.session.secretId }
        _rows.value = load().map { s ->
            prior[s.secretId]?.copy(session = s) ?: SecuredSessionRow(session = s)
        }
    }

    /** True when a refresh would be rate-limited (debounce not yet elapsed). */
    fun canRefresh(secretId: String): Boolean {
        val row = _rows.value.firstOrNull { it.session.secretId == secretId } ?: return false
        val last = row.lastCheckedAt ?: return true
        return now() - last >= refreshDebounceMs
    }

    suspend fun refresh(secretId: String) {
        val row = _rows.value.firstOrNull { it.session.secretId == secretId } ?: return
        if (row.refreshing) return
        // Client-side debounce: a 429 from the box otherwise just wastes a call.
        if (!canRefresh(secretId)) return
        update(secretId) { it.copy(refreshing = true) }
        try {
            val status = client.sessionStatus(row.session.serverId, secretId)
            update(secretId) {
                it.copy(
                    liveness = if (status == "online") SessionLiveness.ONLINE else SessionLiveness.OFFLINE,
                    lastCheckedAt = now(),
                    refreshing = false,
                )
            }
        } catch (e: HttpException) {
            // 429 (rate limited) or any transport error: keep the last-known
            // liveness, just clear the spinner. Mark lastCheckedAt only on a
            // genuine 429 so the debounce backs the user off.
            update(secretId) {
                it.copy(
                    refreshing = false,
                    lastCheckedAt = if (e.status == 429) now() else it.lastCheckedAt,
                )
            }
        } catch (e: Throwable) {
            update(secretId) { it.copy(refreshing = false) }
        }
    }

    /** Stop a session: close it on the box (best-effort), then drop it locally. */
    suspend fun stop(secretId: String) {
        val row = _rows.value.firstOrNull { it.session.secretId == secretId } ?: return
        runCatching { client.closeSession(row.session.serverId, secretId) }
        removeFromStore(secretId)
        _rows.value = _rows.value.filterNot { it.session.secretId == secretId }
    }

    private fun update(secretId: String, transform: (SecuredSessionRow) -> SecuredSessionRow) {
        _rows.value = _rows.value.map { if (it.session.secretId == secretId) transform(it) else it }
    }
}
