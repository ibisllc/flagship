// Kotlin mirror of FlagshipCore/AppState.swift.
//
// App-wide state: who is the user, which pods do they own, which is the
// leader, which is the current screens-client target. Implemented with
// StateFlow so Compose / Flow consumers observe changes idiomatically.

package com.flagship.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class AppState(
    isPaired: Boolean = false,
    currentUser: String? = null,
    pods: List<PodInfo> = emptyList(),
    leaderPodId: String? = null,
    currentPodId: String? = null,
) {
    private val _isPaired = MutableStateFlow(isPaired)
    val isPaired: StateFlow<Boolean> = _isPaired.asStateFlow()

    private val _currentUser = MutableStateFlow(currentUser)
    val currentUser: StateFlow<String?> = _currentUser.asStateFlow()

    private val _pods = MutableStateFlow(pods)
    val pods: StateFlow<List<PodInfo>> = _pods.asStateFlow()

    private val _leaderPodId = MutableStateFlow(leaderPodId ?: pods.firstOrNull()?.podId)
    val leaderPodId: StateFlow<String?> = _leaderPodId.asStateFlow()

    private val _currentPodId = MutableStateFlow(currentPodId ?: _leaderPodId.value)
    val currentPodId: StateFlow<String?> = _currentPodId.asStateFlow()

    val leaderPod: PodInfo? get() = _pods.value.firstOrNull { it.podId == _leaderPodId.value }
    val currentPod: PodInfo? get() = _pods.value.firstOrNull { it.podId == _currentPodId.value } ?: leaderPod

    fun completeOnboarding(username: String, pods: List<PodInfo>) {
        _currentUser.value = username
        _pods.value = pods
        _leaderPodId.value = pods.firstOrNull()?.podId
        _currentPodId.value = pods.firstOrNull()?.podId
        _isPaired.value = true
    }

    fun addPod(pod: PodInfo) {
        _pods.value = _pods.value + pod
        if (_leaderPodId.value == null) _leaderPodId.value = pod.podId
        if (_currentPodId.value == null) _currentPodId.value = pod.podId
    }

    fun setLeader(podId: String) {
        if (_pods.value.none { it.podId == podId }) return
        _leaderPodId.value = podId
    }

    fun setCurrentPod(podId: String) {
        if (_pods.value.none { it.podId == podId }) return
        _currentPodId.value = podId
    }

    fun removePod(podId: String) {
        _pods.value = _pods.value.filter { it.podId != podId }
        if (_leaderPodId.value == podId) _leaderPodId.value = _pods.value.firstOrNull()?.podId
        if (_currentPodId.value == podId) _currentPodId.value = _leaderPodId.value ?: _pods.value.firstOrNull()?.podId
    }

    fun signOut() {
        _isPaired.value = false
        _currentUser.value = null
        _pods.value = emptyList()
        _leaderPodId.value = null
        _currentPodId.value = null
    }
}

/// A single server pod. `name` is the user-facing short label
/// (e.g. "Home"); `description` is a longer one-liner ("Failover for
/// work", "Music projects") shown wherever the FQDN used to live.
/// The FQDN itself is technical and lives only in detail views.
data class PodInfo(
    val podId: String,
    val name: String,
    val description: String? = null,
    val fqdn: String,
    val status: Status = Status.UNKNOWN,
    val pendingAuthCodeSerial: String? = null,
) {
    enum class Status { ONLINE, OFFLINE, UNKNOWN, PENDING }
}

/// Tiny utility for normalizing a user-supplied server name into a DNS
/// label (used as the subdomain prefix inside `.flagship.services`).
object SlugUtil {
    private val allowed = Regex("[^a-z0-9-]")
    fun slugify(name: String): String {
        val lower = name.lowercase().replace(' ', '-')
        val cleaned = allowed.replace(lower, "")
        return cleaned.ifEmpty { "server" }
    }
}
