// P14 Phase 2 — Kotlin mirror of FlagshipUI/ViewModels/CompanionRequestsViewModel.swift.
// Drives the Settings → Companion requests inbox: lists pending unsigned
// write-requests companions have forwarded; the owner approves (which
// IRK-signs + dispatches the destination call) or denies. Failure on the
// destination POST does NOT resolve the row — the companion's request
// stays pending until the owner retries (or it expires server-side).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.CompanionPendingWrite
import com.flagshipserver.app.api.CompanionResolvePendingRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ReleaseServerNameRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.ServerRevocationRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.core.ReleaseServerName
import com.flagshipserver.app.core.ServerRevocationClaim
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

class CompanionRequestsViewModel(
    private val client: ScreensClient,
    private val server: FlagshipServerClient,
    private val username: () -> String?,
    /** Pluggable for tests. Default uses the real Keystore-backed IRK. */
    // Slice D — approving a companion's release/revoke-server request signs a
    // SENSITIVE order (serverRevoke.ts gates it on the admin master root). This
    // runs on the owner's (admin) device: sign with the admin root when held,
    // else the owner IRK (legacy). Canonical bytes unchanged.
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _state = MutableStateFlow<LoadingState<List<CompanionPendingWrite>>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<List<CompanionPendingWrite>>> = _state.asStateFlow()

    private val _resolvePending = MutableStateFlow<Set<String>>(emptySet())
    val resolvePending: StateFlow<Set<String>> = _resolvePending.asStateFlow()

    private val _rowError = MutableStateFlow<Map<String, String>>(emptyMap())
    val rowError: StateFlow<Map<String, String>> = _rowError.asStateFlow()

    private var pollJob: Job? = null

    /** First load — flashes Loading, then a single fetch. */
    fun load(): Job = scope.launch {
        _state.value = LoadingState.Loading
        refresh()
    }

    /**
     * Silent refresh — fetches the pending list WITHOUT flashing Loading (so a
     * poll re-tick doesn't blank the rendered rows) and swallows transport
     * blips, keeping the last-good snapshot. Mirrors iOS `refresh()` + the
     * webapp `pollPending` per-tick behaviour: a tick that fails while we
     * already have rows leaves them in place; only a failure with no rows yet
     * surfaces Failed.
     */
    private suspend fun refresh() {
        runCatching { client.companionPendingWrites() }
            .fold(
                onSuccess = { r ->
                    _state.value = LoadingState.Loaded(r.pending.sortedBy { it.queuedAt })
                },
                onFailure = { t ->
                    if (_state.value !is LoadingState.Loaded) {
                        _state.value = LoadingState.Failed(failureMessage(t))
                    }
                },
            )
    }

    /**
     * Inbox-scoped background poll. Runs a first refresh immediately, then
     * loops every [intervalMs] silently re-fetching. Idempotent — a second
     * call cancels the prior loop. The screen drives this while mounted and
     * cancels it via [stopPolling] on dispose. Mirrors iOS `startPolling()` +
     * the webapp `pollPending` (default 10s cadence).
     */
    fun startPolling(intervalMs: Long = POLL_INTERVAL_MS): Job {
        stopPolling()
        return scope.launch {
            while (isActive) {
                refresh()
                delay(intervalMs)
            }
        }.also { pollJob = it }
    }

    fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    fun approve(request: CompanionPendingWrite): Job = scope.launch {
        clearRowError(request.requestId)
        markPending(request.requestId, true)
        try {
            when (request.kind) {
                "release-server" -> dispatchReleaseServer(request.intent)
                "revoke-server" -> dispatchRevokeServer(request.intent)
                else -> {
                    setRowError(request.requestId, "Unsupported request kind — open your browser to handle")
                    return@launch
                }
            }
        } catch (t: Throwable) {
            setRowError(request.requestId, failureMessage(t))
            return@launch
        } finally {
            markPending(request.requestId, false)
        }
        postResolve(request.requestId, "approved")
    }

    fun deny(request: CompanionPendingWrite): Job = scope.launch {
        clearRowError(request.requestId)
        markPending(request.requestId, true)
        try {
            postResolve(request.requestId, "denied")
        } finally {
            markPending(request.requestId, false)
        }
    }

    private suspend fun postResolve(requestId: String, outcome: String) {
        runCatching {
            client.companionResolvePending(
                CompanionResolvePendingRequest(requestId = requestId, outcome = outcome),
            )
        }.fold(
            onSuccess = {
                val current = _state.value
                if (current is LoadingState.Loaded) {
                    _state.value = LoadingState.Loaded(
                        current.value.filterNot { it.requestId == requestId },
                    )
                }
            },
            onFailure = { t -> setRowError(requestId, failureMessage(t)) },
        )
    }

    private suspend fun dispatchReleaseServer(intent: JsonObject) {
        val user = username().orEmpty()
        if (user.isEmpty()) throw CompanionRequestsError("No active account on this device.")
        val serverDomain = stringField(intent, "serverDomain")
            ?: throw CompanionRequestsError("Companion intent is missing field: serverDomain")
        val intentUsername = stringField(intent, "username") ?: user
        val issuedAt = now()
        val irk = signer("Approve release-server for $serverDomain")
        val canonical = ReleaseServerName.canonicalBytes(
            username = intentUsername,
            serverDomain = serverDomain,
            issuedAt = issuedAt,
        )
        val signature = irk.sign(canonical)
        server.releaseServerName(
            ReleaseServerNameRequest(
                request = ReleaseServerNameRequest.Inner(
                    username = intentUsername,
                    serverDomain = serverDomain,
                    issuedAt = issuedAt,
                ),
                signature = HexUtil.encode(signature),
            ),
        )
    }

    private suspend fun dispatchRevokeServer(intent: JsonObject) {
        val user = username().orEmpty()
        if (user.isEmpty()) throw CompanionRequestsError("No active account on this device.")
        val serverId = stringField(intent, "revokedServerId")
            ?: throw CompanionRequestsError("Companion intent is missing field: revokedServerId")
        val reason = stringField(intent, "reason")
            ?: throw CompanionRequestsError("Companion intent is missing field: reason")
        if (!ServerRevocationClaim.REASONS.contains(reason)) {
            throw CompanionRequestsError("Companion intent is missing field: reason")
        }
        val userId = stringField(intent, "userId") ?: user
        val issuedAt = now()
        val irk = signer("Approve revoke-server for $serverId")
        val canonical = ServerRevocationClaim.canonicalBytes(
            userId = userId,
            revokedServerId = serverId,
            reason = reason,
            issuedAt = issuedAt,
        )
        val signature = irk.sign(canonical)
        server.revokeServer(
            ServerRevocationRequest(
                request = ServerRevocationRequest.Inner(
                    userId = userId,
                    revokedServerId = serverId,
                    reason = reason,
                    issuedAt = issuedAt,
                ),
                signature = HexUtil.encode(signature),
            ),
        )
    }

    private fun stringField(intent: JsonObject, key: String): String? {
        val v = intent[key] ?: return null
        return (v as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    }

    private fun markPending(requestId: String, isPending: Boolean) {
        _resolvePending.value = if (isPending) {
            _resolvePending.value + requestId
        } else {
            _resolvePending.value - requestId
        }
    }

    private fun setRowError(requestId: String, message: String) {
        _rowError.value = _rowError.value + (requestId to message)
    }

    private fun clearRowError(requestId: String) {
        _rowError.value = _rowError.value - requestId
    }

    private fun failureMessage(t: Throwable): String = when (t) {
        is ScreensError.Http -> NetworkErrorHumanizer.humanize(t)
        is CompanionRequestsError -> t.message ?: "Companion intent is malformed."
        else -> t.message ?: "couldn't complete the request"
    }

    companion object {
        /** 10s between polls while the inbox is open — mirrors the webapp's
         *  `pollPending` default (`companionRequestsClient.js` intervalMs). */
        const val POLL_INTERVAL_MS = 10_000L
    }
}

class CompanionRequestsError(message: String) : Throwable(message)
