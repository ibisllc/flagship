// Kotlin mirror of FlagshipCore/AppState.swift.
//
// App-wide state: who is the user, which pods do they own, which is the
// leader, which is the current screens-client target. Implemented with
// StateFlow so Compose / Flow consumers observe changes idiomatically.

package com.flagshipserver.app.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class AppState(
    isPaired: Boolean = false,
    currentUser: String? = null,
    pods: List<PodInfo> = emptyList(),
    leaderPodId: String? = null,
    currentPodId: String? = null,
    hasCloudRecovery: Boolean = true,
    recoveryNudgeDismissedThisSession: Boolean = false,
    accountWasReset: Boolean = false,
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

    /**
     * True once the user has uploaded a WebAuthn-PRF cloud recovery
     * envelope for the current account. Mirror of
     * FlagshipCore/AppState.swift's hasCloudRecovery. Defaults true so
     * the recovery nudge doesn't flash before the .com lookup completes.
     */
    private val _hasCloudRecovery = MutableStateFlow(hasCloudRecovery)
    val hasCloudRecovery: StateFlow<Boolean> = _hasCloudRecovery.asStateFlow()
    fun setHasCloudRecovery(value: Boolean) { _hasCloudRecovery.value = value }

    /**
     * Drives the Home recovery-setup nudge — when the user taps "Not
     * now" we suppress it for this app session only; next launch
     * re-surfaces it. Recovery is important enough to keep nudging.
     */
    private val _recoveryNudgeDismissedThisSession = MutableStateFlow(recoveryNudgeDismissedThisSession)
    val recoveryNudgeDismissedThisSession: StateFlow<Boolean> = _recoveryNudgeDismissedThisSession.asStateFlow()
    fun dismissRecoveryNudgeForSession() { _recoveryNudgeDismissedThisSession.value = true }

    /**
     * E7 — true once we've observed that this device's local push
     * tokenId is no longer in /api/users/:u/devices, meaning another
     * device on the account ran a Disconnect / Replace / Wipe against
     * us. The Home banner uses this to render a danger card with a
     * "Sign in again" CTA.
     */
    private val _accountWasReset = MutableStateFlow(accountWasReset)
    val accountWasReset: StateFlow<Boolean> = _accountWasReset.asStateFlow()
    fun setAccountWasReset(value: Boolean) { _accountWasReset.value = value }

    val leaderPod: PodInfo? get() = _pods.value.firstOrNull { it.podId == _leaderPodId.value }
    val currentPod: PodInfo? get() = _pods.value.firstOrNull { it.podId == _currentPodId.value } ?: leaderPod

    /**
     * True when the recovery-setup nudge should be visible on Home.
     * Same gating truth-table as the iOS mirror:
     *   - cloud recovery NOT yet enrolled, and
     *   - the user hasn't dismissed the nudge this session, and
     *   - at least one ONLINE pod (so they're past day-0 onboarding).
     * Pure-derivation getter; UI calls it at render time off the
     * underlying StateFlows.
     */
    fun shouldShowRecoveryNudgeNow(): Boolean {
        if (_hasCloudRecovery.value) return false
        if (_recoveryNudgeDismissedThisSession.value) return false
        return _pods.value.any { it.status == PodInfo.Status.ONLINE }
    }

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
