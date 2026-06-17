// Kotlin mirror of FlagshipUI/ViewModels/ServiceDetailViewModel.swift.
//
// Owns the per-service detail surface: the app-detail response (header,
// data layer, members, browser tabs, logs, last backup) plus the local
// edit buffer for pod placement + the per-service lead pod. `load()`
// fetches /api/screens/app-detail/:serviceId off the (pinned) box;
// `save()` ships the run-policy diff through orders/send; `uninstall()`
// ships a service-uninstall order through the same channel. Both are real
// client calls — exactly the iOS save mechanism, generalized to uninstall.
//
// The WEB DOMAINS / Replace / custom-domain machinery stays on
// RenameServiceViewModel (the iOS split is the same: AppLinks live on a
// sibling path). This VM never touches it.
//
// When the contract changes, update this file AND
// apps/mobile/ios/Sources/FlagshipUI/ViewModels/ServiceDetailViewModel.swift
// in the same commit.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.OrdersSendRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.core.PodInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class ServiceDetailViewModel(
    val serviceId: String,
    private val client: ScreensClient,
    private val allPods: List<PodInfo>,
    private val globalLeaderPodId: String?,
) : ViewModel() {

    private val _detail = MutableStateFlow<LoadingState<AppDetailResponse>>(LoadingState.Idle)
    val detail: StateFlow<LoadingState<AppDetailResponse>> = _detail.asStateFlow()

    /** Set when the last failure was a box cert-pin mismatch (UX-A) — the UI
     *  promotes this to a security warning instead of a retry hint. Mirrors
     *  the iOS `ScreensClientError.userFacing` cert-pin branch. */
    private val _certMismatch = MutableStateFlow(false)
    val certMismatch: StateFlow<Boolean> = _certMismatch.asStateFlow()

    /** Pods the service should run on (local edit buffer). Seeded from the
     *  leader on first load; persisted by [save]. */
    private val _runOnPodIds = MutableStateFlow<Set<String>>(emptySet())
    val runOnPodIds: StateFlow<Set<String>> = _runOnPodIds.asStateFlow()

    /** Pod that gets the canonical short domain for this service. null = use
     *  the global leader. */
    private val _leadPodId = MutableStateFlow<String?>(null)
    val leadPodId: StateFlow<String?> = _leadPodId.asStateFlow()

    val availablePods: List<PodInfo> get() = allPods
    val effectiveLeadPodId: String? get() = _leadPodId.value ?: globalLeaderPodId

    fun load() = viewModelScope.launch {
        _detail.value = LoadingState.Loading
        _certMismatch.value = false
        try {
            val d = client.appDetail(serviceId)
            _detail.value = LoadingState.Loaded(d)
            // Seed local edits from server state. The BFF doesn't yet return a
            // multi-pod policy, so default to the leader-only — same as iOS.
            if (_runOnPodIds.value.isEmpty()) {
                val lead = globalLeaderPodId
                if (lead != null) _runOnPodIds.value = setOf(lead)
            }
        } catch (t: Throwable) {
            val classified = NetworkErrorHumanizer.classify(t)
            _certMismatch.value = classified.kind == NetworkErrorHumanizer.Kind.CERT_PIN_MISMATCH
            _detail.value = LoadingState.Failed(classified.message)
        }
    }

    fun togglePod(podId: String) {
        val cur = _runOnPodIds.value
        _runOnPodIds.value = if (cur.contains(podId)) cur - podId else cur + podId
        // If we deselected the lead, clear it so the global leader takes back over.
        if (_leadPodId.value == podId && !_runOnPodIds.value.contains(podId)) {
            _leadPodId.value = null
        }
    }

    fun setLead(podId: String) {
        _runOnPodIds.value = _runOnPodIds.value + podId
        _leadPodId.value = podId
    }

    /** Ship the run-policy edits as a signed order envelope. The shape mirrors
     *  what packages/server-daemon expects for service-policy updates — a
     *  canonical-bytes wrapper. Byte-identical to the iOS `save()` payload
     *  (sorted keys, base64). */
    suspend fun save() {
        val envelope = encodeEnvelope(
            kind = "service-policy/v1",
            extra = mapOf(
                "runOnPodIds" to JsonArray(_runOnPodIds.value.sorted().map { JsonPrimitive(it) }),
                "leadPodId" to (_leadPodId.value?.let { JsonPrimitive(it) } ?: JsonNull),
            ),
        )
        client.ordersSend(OrdersSendRequest(envelope = envelope, kind = "service-policy/v1"))
    }

    /** Uninstall the service. Real client call over the same orders/send
     *  channel as [save] — the iOS reference left this a container-level toast
     *  stub; here it dispatches a service-uninstall order. */
    suspend fun uninstall() {
        val envelope = encodeEnvelope(kind = "service-uninstall/v1", extra = emptyMap())
        client.ordersSend(OrdersSendRequest(envelope = envelope, kind = "service-uninstall/v1"))
    }

    private fun encodeEnvelope(kind: String, extra: Map<String, kotlinx.serialization.json.JsonElement>): String {
        // sortedMapOf so the serialized key order is deterministic, matching
        // iOS's JSONSerialization(.sortedKeys) — the canonical bytes the
        // daemon dispatcher hashes must agree across platforms.
        val fields = sortedMapOf<String, kotlinx.serialization.json.JsonElement>(
            "kind" to JsonPrimitive(kind),
            "serviceId" to JsonPrimitive(serviceId),
        )
        fields.putAll(extra)
        val json = Json.encodeToString(JsonObject.serializer(), JsonObject(fields))
        // Standard base64 (with padding), matching iOS's
        // Data.base64EncodedString(). java.util.Base64 is JVM-safe (no
        // Android stub), so save()/uninstall() are unit-testable.
        return java.util.Base64.getEncoder().encodeToString(json.toByteArray(Charsets.UTF_8))
    }
}
