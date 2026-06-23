// Kotlin mirror of FlagshipCore/AppState.swift.
//
// App-wide state: who is the user, which pods do they own, which is the
// leader, which is the current screens-client target. Implemented with
// StateFlow so Compose / Flow consumers observe changes idiomatically.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.api.DeviceCapabilityBlock
import com.flagshipserver.app.api.DeviceScope
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

// W8 NOTE: Android doesn't have iCloud-style auto-sync of secrets across
// devices the way Apple does. Keys live in the AndroidKeyStore (or in
// EncryptedSharedPreferences wrapped under an AndroidKeyStore master
// key), and they DO NOT replicate to other devices that share the
// user's Google account. The Keychain sync-class split that the iOS
// build needs (root keys MUST sync via iCloud Keychain; device keys
// MUST NOT) is a no-op here. We carry [KeychainSyncClass] as a
// type-level marker so the future "Google Account–backed sync" feature
// (if we ever ship it) can wire the same discipline through; today
// every Android write is implicitly device-local.

/** W8 marker — see header comment. Android writes are always
 *  device-local; the enum exists for parity with the iOS Keychain
 *  wrapper and so the v2 device-IRK split has a shared vocabulary. */
enum class KeychainSyncClass { CloudRoot, DeviceLocal }

/** W3 — durable profile descriptor. A "cloud" is what we used to call
 *  a "username" — each cloud has one root key (today's IRK). One
 *  phone can hold multiple profiles (personal + family + work) and
 *  switch between them. Phase F demo case is one profile per phone;
 *  multi-profile is the v2 capability that makes corporate / family
 *  setups work. */
@Serializable
data class Profile(
    val cloudName: String,
    val cloudRootPubHex: String = "",
    val deviceLabel: String? = null,
    val deviceCapability: DeviceCapabilityBlock? = null,
    val demoServer: DemoServerBlock? = null,
    val createdAt: Long = System.currentTimeMillis(),
)

class AppState(
    isPaired: Boolean = false,
    currentUser: String? = null,
    pods: List<PodInfo> = emptyList(),
    leaderPodId: String? = null,
    currentPodId: String? = null,
    hasCloudRecovery: Boolean = true,
    recoveryNudgeDismissedThisSession: Boolean = false,
    accountWasReset: Boolean = false,
    requireBiometricAtLaunch: Boolean = false,
    isUnlocked: Boolean? = null,
    deviceCapability: DeviceCapabilityBlock? = null,
    profiles: List<Profile> = emptyList(),
    activeCloudName: String? = null,
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
     * Set the instant a BRAND-NEW account is opened (create path only),
     * so the SKIPPABLE "Secure your account" backup nudge shows once —
     * AFTER isPaired flips and the shell mounts, but layered ABOVE it
     * until the user backs up or skips. The recovery / "I already have
     * an account" path never sets this, so it never sees the step.
     * One-shot: cleared on done / skip and never re-armed automatically.
     */
    private val _pendingSecureAccountNudge = MutableStateFlow(false)
    val pendingSecureAccountNudge: StateFlow<Boolean> = _pendingSecureAccountNudge.asStateFlow()
    fun armSecureAccountNudge() { _pendingSecureAccountNudge.value = true }
    fun clearSecureAccountNudge() { _pendingSecureAccountNudge.value = false }

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

    /**
     * C12 — when true, the app requires a successful BiometricPrompt
     * evaluation at launch (and on resume from background) before any
     * content beyond the lock screen renders. Hydrated from
     * PrivacySettings at activity startup.
     */
    private val _requireBiometricAtLaunch = MutableStateFlow(requireBiometricAtLaunch)
    val requireBiometricAtLaunch: StateFlow<Boolean> = _requireBiometricAtLaunch.asStateFlow()
    fun setRequireBiometricAtLaunch(value: Boolean) {
        _requireBiometricAtLaunch.value = value
        if (!value) _isUnlocked.value = true
    }

    /**
     * C12 — in-memory unlock latch. True after a successful biometric
     * authentication; false when the app moves to background (if the
     * gate is armed). Initial value depends on requireBiometricAtLaunch.
     */
    private val _isUnlocked = MutableStateFlow(isUnlocked ?: !requireBiometricAtLaunch)
    val isUnlocked: StateFlow<Boolean> = _isUnlocked.asStateFlow()

    /** True when the lock screen was reached by an EXPLICIT user action (the
     *  Settings "Lock" button) rather than a launch/background relock. The lock
     *  screen suppresses its auto-biometric prompt in this case so a deliberate
     *  lock waits for the user to tap "Unlock" — locking and then being instantly
     *  auto-unlocked is pointless. Auto-prompt stays on for launch +
     *  return-from-background. Cleared on a successful unlock. Mirror of iOS. */
    private val _awaitingManualUnlock = MutableStateFlow(false)
    val awaitingManualUnlock: StateFlow<Boolean> = _awaitingManualUnlock.asStateFlow()

    fun markUnlocked() {
        _isUnlocked.value = true
        _awaitingManualUnlock.value = false
    }
    fun relockForBackground() {
        if (_requireBiometricAtLaunch.value) _isUnlocked.value = false
    }

    /**
     * Tier 1 — LOCK. Explicitly re-gate the app behind the biometric
     * lock screen WITHOUT touching anything else: the Keystore key
     * material, the active session, the pod list — all stay exactly as
     * they are. This is the cheapest of the three "leave the app"
     * actions: a snoop who picks up the phone sees the lock screen, and
     * the user re-enters with BiometricPrompt via the existing
     * BiometricLockScreen.
     *
     * Unlike [relockForBackground], this does NOT consult
     * [requireBiometricAtLaunch] — locking explicitly is a deliberate
     * user action and must always re-gate, even when the auto-lock-on-
     * launch preference is off. The lock screen's unlock button drives
     * [markUnlocked] to come back. Mirror of iOS AppState.lock().
     */
    fun lock() {
        _isUnlocked.value = false
        // Deliberate lock ⇒ the lock screen must WAIT for an explicit tap, not
        // auto-prompt and instantly undo the lock.
        _awaitingManualUnlock.value = true
    }

    /**
     * v2 device-addressing — the effective scopes the current device
     * holds under the signed-in user. Null ⇒ legacy single-IRK path
     * (no restriction; every scope implicit). When non-null AND the
     * scope set is partial, the home screen renders a chip below the
     * username and greys out actions absent from `scopes`.
     */
    private val _deviceCapability = MutableStateFlow(deviceCapability)
    val deviceCapability: StateFlow<DeviceCapabilityBlock?> = _deviceCapability.asStateFlow()
    fun setDeviceCapability(value: DeviceCapabilityBlock?) { _deviceCapability.value = value }

    /** v2 device-addressing — true iff the current device is a
     *  restricted sub-identity (capability present AND scopes don't
     *  cover the full DeviceScope set). UI gates the chip + tooltips
     *  on this. */
    fun isRestrictedDevice(): Boolean {
        val cap = _deviceCapability.value ?: return false
        return !cap.isFullyScoped
    }

    /** v2 device-addressing — true iff the current device may perform
     *  [scope]. A null capability (legacy single-IRK) implicitly holds
     *  every scope; the UI re-uses this to enable / disable buttons. */
    fun hasScope(scope: DeviceScope): Boolean {
        val cap = _deviceCapability.value ?: return true
        return scope in cap.scopeSet
    }

    /** W3 — durable list of clouds this phone is a member of. The
     *  single-identity fields (`currentUser`, `pods`, `deviceCapability`)
     *  reflect the ACTIVE profile. Empty in the unpaired state. */
    private val _profiles = MutableStateFlow(profiles)
    val profiles: StateFlow<List<Profile>> = _profiles.asStateFlow()

    /** W3 — `cloudName` of the entry in [profiles] whose session state
     *  is mirrored into [currentUser] / [pods] / [deviceCapability].
     *  Null ⇒ no active profile (unpaired). */
    private val _activeCloudName = MutableStateFlow(
        activeCloudName ?: profiles.firstOrNull { it.cloudName == currentUser }?.cloudName,
    )
    val activeCloudName: StateFlow<String?> = _activeCloudName.asStateFlow()

    /** Convenience: the active [Profile] descriptor, or null. */
    val activeProfile: Profile? get() {
        val name = _activeCloudName.value ?: return null
        return _profiles.value.firstOrNull { it.cloudName == name }
    }

    /**
     * The Box Request Inbox (docs/box-request-inbox.md): ONE typed object, keyed
     * by lowercased fqdn → the list of approvals that box is currently asking its
     * owner for. Mirrors the backend's `/pods` `pendingRequests` digest —
     * `unlock-key` and `entitlement` are two `type` values in ONE inbox, not two
     * parallel sets. Populated by ONE account-level poll (BootApprovalWatcher) so
     * the list / card / detail read a per-server "what is it asking me?" without N
     * pollers. Empty ⇒ nothing waiting (or not polled yet). The legacy
     * hasLiveUnlockRequest / hasLiveEntitlementRequest accessors are DERIVED from
     * this by filtering on `type`. Mirror of iOS AppState.boxRequestInbox.
     */
    private val _boxRequestInbox = MutableStateFlow<Map<String, List<BoxRequest>>>(emptyMap())
    val boxRequestInbox: StateFlow<Map<String, List<BoxRequest>>> = _boxRequestInbox.asStateFlow()
    fun setBoxRequestInbox(inbox: Map<String, List<BoxRequest>>) {
        _boxRequestInbox.value = inbox.mapKeys { it.key.lowercase() }
    }

    /** Every pending request across all of the owner's boxes, newest first —
     *  the flat inbox the inbox view renders from. */
    val boxRequests: List<BoxRequest>
        get() = _boxRequestInbox.value.values.flatten().sortedByDescending { it.issuedAt }

    /** The pending requests for [fqdn] of a given type (case-folds the lookup). */
    fun boxRequests(fqdn: String, type: SecretPurpose): List<BoxRequest> =
        (_boxRequestInbox.value[fqdn.lowercase()] ?: emptyList()).filter { it.type == type }

    /** Lowercased fqdns with a live request of [type] — the display set a view
     *  projects from the unified inbox (mirrors the old serversAwaiting* shape,
     *  now derived). */
    fun serversAwaiting(type: SecretPurpose): Set<String> =
        _boxRequestInbox.value.filterValues { reqs -> reqs.any { it.type == type } }.keys

    /** True iff [fqdn] has a live pending unlock request right now. Derived from
     *  the unified inbox (`type == UNLOCK_KEY`). */
    fun hasLiveUnlockRequest(fqdn: String): Boolean =
        boxRequests(fqdn, SecretPurpose.UNLOCK_KEY).isNotEmpty()

    /** True iff [fqdn] is waiting for the owner to authorize it to serve.
     *  Derived from the unified inbox (`type == ENTITLEMENT`). */
    fun hasLiveEntitlementRequest(fqdn: String): Boolean =
        boxRequests(fqdn, SecretPurpose.ENTITLEMENT).isNotEmpty()

    /** Liveness for [pod] using the cheap directory `awaitingUnlock` flag OR
     *  the account-level Box Request Inbox — either means the box is actively
     *  waiting, so it must not read "never came online". */
    fun liveness(pod: PodInfo): PodInfo.LivenessState =
        pod.livenessState(
            hasLiveUnlockRequest = pod.awaitingUnlock ||
                hasLiveUnlockRequest(pod.fqdn) ||
                hasLiveEntitlementRequest(pod.fqdn),
        )

    val leaderPod: PodInfo? get() = _pods.value.firstOrNull { it.podId == _leaderPodId.value }

    /** DETERMINISTIC FALLBACK (Fix C) — the OLDEST pod. `.com` returns `/pods`
     *  oldest-first, so `pods.first()` IS the oldest. The UI default pod / leader
     *  must NEVER silently float to a brand-new box; when an explicit anchor is
     *  missing or dangling it re-anchors HERE — the stable, oldest pod — so
     *  adding a server can't seize the default. null only when there are no pods.
     *  Mirror of iOS AppState.oldestPod. */
    private val oldestPod: PodInfo? get() = _pods.value.firstOrNull()

    val currentPod: PodInfo?
        get() {
            val id = _currentPodId.value
            if (id != null) {
                val p = _pods.value.firstOrNull { it.podId == id }
                if (p != null) return p
            }
            // The leader is the UI default. If it resolves use it; otherwise fall
            // back to the OLDEST pod (deterministic) — never the newest box.
            return leaderPod ?: oldestPod
        }

    /** The GLOBAL anchor pod for Home/Services (the default box session). Unlike
     *  [currentPod] — which resolves to the LEADER and thus, by default, the
     *  OLDEST pod regardless of liveness — this prefers a genuinely-LIVE pod
     *  (HONEST LIVENESS, Fix A: `Status.ONLINE` now means a real heartbeat, not
     *  mere registration). A registered-but-dead/unreachable pod that happens to
     *  be the leader must NOT anchor the global session. Mirror of iOS
     *  AppState.sessionPod. */
    val sessionPod: PodInfo?
        get() {
            val cur = currentPod
            if (cur != null && cur.status == PodInfo.Status.ONLINE) return cur
            return _pods.value.firstOrNull { it.status == PodInfo.Status.ONLINE }
        }

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
        // W3 — record the cloud in the durable profile list and mark
        // it active. Idempotent for re-onboarding the same cloud.
        upsertProfile(
            Profile(
                cloudName = username,
                cloudRootPubHex = "",
                deviceLabel = _deviceCapability.value?.label,
                deviceCapability = _deviceCapability.value,
                demoServer = null,
                createdAt = System.currentTimeMillis(),
            ),
        )
        _activeCloudName.value = username
    }

    /** Restore a previously paired session on cold launch. The shell
     *  calls this when the Keystore still holds a UMK seed (a real
     *  identity that survives process death) so the user lands on the
     *  (biometric-gated) shell instead of a fresh sign-in. Pods are left
     *  empty; the tabs refetch them. No-op if already paired (a live
     *  pairing wins). Demo/mock sessions never store a UMK seed, so the
     *  shell never calls this for them — they fall through to Welcome. */
    fun restorePersistedSession(username: String) {
        if (_isPaired.value) return
        completeOnboarding(username, emptyList())
    }

    /** W3 — register a new profile (or refresh an existing entry with
     *  the same `cloudName`) and optionally make it active. */
    fun addProfile(profile: Profile, setActive: Boolean = true) {
        upsertProfile(profile)
        if (setActive) setActiveProfile(profile.cloudName)
    }

    /** W3 — switch the active profile. Mirrors the chosen profile's
     *  session state into the single-identity fields so callsites
     *  reading [currentUser] / [deviceCapability] see the new cloud.
     *  Pods are NOT carried across — the new cloud's pods are fetched
     *  fresh from /devices. No-op if [cloudName] isn't in [profiles]. */
    fun setActiveProfile(cloudName: String) {
        val p = _profiles.value.firstOrNull { it.cloudName == cloudName } ?: return
        _activeCloudName.value = cloudName
        _currentUser.value = p.cloudName
        _deviceCapability.value = p.deviceCapability
        _pods.value = emptyList()
        _leaderPodId.value = null
        _currentPodId.value = null
        _isPaired.value = true
        // W3 multi-profile keystore — point the Keystore at THIS
        // profile's per-profile device-key slot so deriveIRK / installUmk
        // / etc. operate on the cloud the user just switched to. The
        // profileId is the lowercased cloudName (Keystore normalizes).
        Keystore.setActiveProfile(cloudName)
    }

    private fun upsertProfile(profile: Profile) {
        val current = _profiles.value
        val idx = current.indexOfFirst { it.cloudName == profile.cloudName }
        _profiles.value = if (idx >= 0) {
            current.toMutableList().also { it[idx] = profile }
        } else {
            current + profile
        }
    }

    fun addPod(pod: PodInfo) {
        _pods.value = _pods.value + pod
        // STICKY LEADERSHIP (Fix C) — a newly-added box must NEVER change the
        // leader / default pod. A new server auto-seizing leadership was the
        // reported bug. Seed leader/current ONLY when none is set yet (the genuine
        // first-pod / cold-restore case); an existing leader is left exactly as it
        // is, so the new box is just another selectable pod — not the new default.
        if (_leaderPodId.value == null) _leaderPodId.value = pod.podId
        if (_currentPodId.value == null) _currentPodId.value = pod.podId
    }

    /** #56 — registration is AUTHORITATIVE for online. A server present in the
     *  registered `/pods` inventory is rendered ONLINE regardless of any
     *  heartbeat / cert side-channel (those aren't populated for a
     *  content-blind `.com` or a just-live box). Identity is unified on the
     *  fqdn: if a pod (pending or otherwise) already exists for this fqdn it's
     *  flipped to ONLINE in place (preserving leader/current selection and not
     *  clobbering a richer name); otherwise a fresh ONLINE pod is added. The
     *  online pod always wins over a pending duplicate sharing the fqdn.
     *  Returns the resolved pod id. Mirror of iOS AppState.upsertRegisteredPod. */
    fun upsertRegisteredPod(
        fqdn: String,
        name: String,
        description: String? = null,
        cameOnline: Boolean = true,
        registeredAt: Long = 0,
        awaitingUnlock: Boolean = false,
        liveness: PodInfo.Liveness? = null,
        lastSeenMsAgo: Long? = null,
        lastReported: Long? = null,
        identityPubKeyHex: String = "",
        leadsServices: List<String> = emptyList(),
    ): String {
        // HONEST LIVENESS (Fix A) — derive the pod's status from the
        // server-authoritative `liveness` field instead of trusting that a
        // registered box is ONLINE. `live` → ONLINE; `unreachable` → OFFLINE (a
        // previously-live box now stale); `never` → UNKNOWN (registered, awaiting
        // its first heartbeat — NOT session-eligible, so it can't anchor a box
        // session or be picked as a live leader). When `.com` didn't send the
        // field (a pre-field Worker), fall back to the legacy
        // registration-is-online behavior so existing tests stay green.
        val derivedStatus: PodInfo.Status = when (liveness) {
            PodInfo.Liveness.LIVE -> PodInfo.Status.ONLINE
            PodInfo.Liveness.UNREACHABLE -> PodInfo.Status.OFFLINE
            PodInfo.Liveness.NEVER -> PodInfo.Status.UNKNOWN
            null -> PodInfo.Status.ONLINE
        }
        val target = fqdn.lowercase()
        val existing = _pods.value
        val idx = existing.indexOfFirst { it.fqdn.lowercase() == target }
        if (idx >= 0) {
            val old = existing[idx]
            // Already at the derived liveness with a confirmed check-in AND not
            // waiting AND the liveness signal hasn't changed — nothing to do
            // (don't clobber a richer name). A box whose reachability changed,
            // came online, or is now waiting for an approval is re-flowed below.
            if (old.status == derivedStatus && old.cameOnline && !awaitingUnlock &&
                old.liveness == liveness && old.lastSeenMsAgo == lastSeenMsAgo &&
                old.leadsServices == leadsServices
            ) {
                return old.podId
            }
            _pods.value = existing.toMutableList().also {
                it[idx] = old.copy(
                    name = old.name.ifEmpty { name },
                    description = old.description ?: description,
                    status = derivedStatus,
                    pendingAuthCodeSerial = null,
                    cameOnline = cameOnline,
                    // Keep a known registration time; never downgrade to 0.
                    registeredAt = if (registeredAt > 0) registeredAt else old.registeredAt,
                    awaitingUnlock = awaitingUnlock,
                    liveness = liveness,
                    lastSeenMsAgo = lastSeenMsAgo,
                    lastReported = lastReported ?: old.lastReported,
                    // Keep a known STK; never downgrade to empty on a sparse update.
                    identityPubKeyHex = identityPubKeyHex.ifEmpty { old.identityPubKeyHex },
                    leadsServices = leadsServices,
                )
            }
            return old.podId
        }
        val id = PodInfo.podId(fqdn)
        addPod(
            PodInfo(
                podId = id,
                name = name,
                description = description,
                fqdn = fqdn,
                status = derivedStatus,
                cameOnline = cameOnline,
                registeredAt = registeredAt,
                awaitingUnlock = awaitingUnlock,
                liveness = liveness,
                lastSeenMsAgo = lastSeenMsAgo,
                lastReported = lastReported,
                identityPubKeyHex = identityPubKeyHex,
                leadsServices = leadsServices,
            ),
        )
        return id
    }

    /** Idempotent insert of a pending pod, keyed on the fqdn (the same
     *  identity rule as [upsertRegisteredPod]). The create flow fires this
     *  the moment an order is DELIVERED — not when the install-progress
     *  screen finishes — so the pod can already exist: surfaced serial-less
     *  by the `/pods` reconciler (the unauthenticated directory never
     *  carries the raw serial), or re-fired when the progress screen is
     *  left. Merging attaches this device's locally-known auth-code serial
     *  to a serial-less twin, restoring the deep-progress/cancel capability
     *  the order's creator owns; a known serial is never downgraded to null
     *  and an online pod always wins. Returns the resolved pod id.
     *  Mirror of iOS AppState.upsertPendingPod. */
    fun upsertPendingPod(
        name: String,
        description: String? = null,
        fqdn: String,
        serial: String?,
    ): String {
        val target = fqdn.lowercase()
        val newSerial = serial?.takeIf { it.isNotEmpty() }
        val existing = _pods.value
        if (target.isNotEmpty()) {
            val idx = existing.indexOfFirst { it.fqdn.lowercase() == target }
            if (idx >= 0) {
                val old = existing[idx]
                if (old.status == PodInfo.Status.ONLINE) return old.podId
                _pods.value = existing.toMutableList().also {
                    it[idx] = old.copy(
                        name = name.ifEmpty { old.name },
                        description = description?.takeIf { d -> d.isNotEmpty() } ?: old.description,
                        status = PodInfo.Status.PENDING,
                        pendingAuthCodeSerial = newSerial ?: old.pendingAuthCodeSerial,
                    )
                }
                return old.podId
            }
        }
        // An empty fqdn (no predicted domain yet) has no stable identity —
        // fall back to a random id for it.
        val podId = if (fqdn.isEmpty()) {
            "pod-" + java.util.UUID.randomUUID().toString().take(6).lowercase()
        } else {
            PodInfo.podId(fqdn)
        }
        addPod(
            PodInfo(
                podId = podId,
                name = name,
                description = description?.takeIf { it.isNotEmpty() },
                fqdn = fqdn,
                status = PodInfo.Status.PENDING,
                pendingAuthCodeSerial = newSerial,
            ),
        )
        return podId
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
        // DETERMINISTIC RE-ANCHOR (Fix C) — when the removed pod WAS the leader,
        // the leader dangles. Re-anchor explicitly to the OLDEST remaining pod
        // (`oldestPod`, = `pods.first()` since `.com` returns oldest-first) rather
        // than letting `currentPod` silently float to whatever happens to be
        // first. A non-leader removal leaves the leader untouched (sticky).
        if (_leaderPodId.value == podId) _leaderPodId.value = oldestPod?.podId
        if (_currentPodId.value == podId) _currentPodId.value = _leaderPodId.value ?: oldestPod?.podId
    }

    fun signOut() {
        _isPaired.value = false
        _currentUser.value = null
        _pods.value = emptyList()
        _leaderPodId.value = null
        _currentPodId.value = null
        _deviceCapability.value = null
        _activeCloudName.value = null
        // Welcome doesn't need the gate (passkey auth coming up); the
        // preference itself stays so a future re-pair re-arms.
        _isUnlocked.value = true
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
    /** For demo-mode pods (Plan A), the latest demoServer block backing
     *  this device — carries the provisioning `phase` + device-identifying
     *  metadata so the Home list can render a thin progress bar and the
     *  detail page can show the step list + the device info block. Null
     *  for non-demo pods. Mirror of iOS PodInfo.demoServer. */
    val demoServer: com.flagshipserver.app.api.DemoServerBlock? = null,
    /** False for a server that registered its STK during install but whose
     *  daemon never checked in (no `lastReported`, no cert in `/pods`) — a
     *  "registered but never came online" box. Defaults true so every other
     *  path is unaffected; only the reconciler flips it false from the
     *  directory. The UI marks the pod "Never came online" and offers the
     *  decommission/free-the-name delete instead of the lost/stolen revoke.
     *  Mirror of iOS PodInfo.cameOnline. */
    val cameOnline: Boolean = true,
    /** Wall-clock ms the box's registration was admitted (from `/pods`
     *  `registeredAt`). Drives the "coming online" grace window: a box that
     *  registered RECENTLY but hasn't checked in yet is provisioning, not dead.
     *  0 ⇒ unknown / not registered. Mirror of iOS PodInfo.registeredAt. */
    val registeredAt: Long = 0,
    /** Cheap, non-biometric "this box is waiting for a boot-unlock approval
     *  right now" flag, straight from `/pods` (`awaitingUnlock`). Feeds the
     *  liveness classifier so a locked box reads "waiting for approval" (and
     *  the decommission/delete stays hidden) instead of "never came online".
     *  Mirror of iOS PodInfo.awaitingUnlock. */
    val awaitingUnlock: Boolean = false,
    /** HONEST LIVENESS (Fix A) — the server-authoritative reachability
     *  classification from the `/pods` directory (`liveness: "live" |
     *  "unreachable" | "never"`). `.com` computes this from the box's
     *  daemon-status heartbeat against a freshness window — so the phone STOPS
     *  trusting mere registration as "online". null ⇒ a pre-field Worker response
     *  that didn't carry the field (the reconciler falls back to the
     *  registration-derived path). Mirror of iOS PodInfo.liveness. */
    val liveness: Liveness? = null,
    /** Wall-clock ms since the box's last daemon-status check-in, from `/pods`
     *  (`lastSeenMsAgo`). Humanized into "offline — last seen <…>" when the box
     *  is [Liveness.UNREACHABLE]. null ⇒ never checked in (or a pre-field
     *  Worker). Mirror of iOS PodInfo.lastSeenMsAgo. */
    val lastSeenMsAgo: Long? = null,
    /** Wall-clock ms of the box's last daemon-status check-in (`lastReported`
     *  from `/pods`), threaded for completeness. null ⇒ never reported. Mirror
     *  of iOS PodInfo.lastReported. */
    val lastReported: Long? = null,
    /** The box's registered STK (its identity pubkey, hex) from `/pods`
     *  (`identityPubKey`). Threaded onto the model so the "Set as preferred
     *  server" owner vote can name THIS box's STK (`preferredStkPubHex`) without a
     *  second directory fetch. Empty for pending/demo pods. Mirror of iOS
     *  PodInfo.identityPubKeyHex. */
    val identityPubKeyHex: String = "",
    /** Per-service leadership (Phase 6) — the service slugs this box currently
     *  LEADS, relayed verbatim from `/pods` (`leadsServices`). Additive + tolerant
     *  of absence: empty when `.com` didn't carry it (pre-field Worker) or the box
     *  leads nothing. Surfaced as a small "lead" indicator on the server card.
     *  Mirror of iOS PodInfo.leadsServices. */
    val leadsServices: List<String> = emptyList(),
) {
    enum class Status { ONLINE, OFFLINE, UNKNOWN, PENDING }

    /** Server-authoritative reachability, mirroring `.com`'s `/pods` `liveness`
     *  field. Mirror of iOS PodInfo.Liveness. */
    enum class Liveness(val wire: String) {
        LIVE("live"), UNREACHABLE("unreachable"), NEVER("never");

        companion object {
            /** Decode the wire string; null for absent/unknown (pre-field Worker). */
            fun fromWire(raw: String?): Liveness? = when (raw) {
                "live" -> LIVE
                "unreachable" -> UNREACHABLE
                "never" -> NEVER
                else -> null
            }
        }
    }

    /** Derived per-server liveness — the single classifier the list, the
     *  detail page, and the post-creation checklist share. Mirror of iOS
     *  PodInfo.LivenessState. */
    enum class LivenessState {
        ONLINE,
        WAITING_FOR_APPROVAL,
        COMING_ONLINE,
        DEAD,

        /** HONEST LIVENESS — the box HAS checked in before but its heartbeat has
         *  gone stale (server-authoritative `liveness == "unreachable"`). Unlike
         *  [DEAD] (never came online) this is a previously-live box that's now
         *  offline; the UI shows "offline — last seen <…>", NOT the decommission
         *  path. Reachable again on the next live heartbeat. Mirror of iOS. */
        OFFLINE,
    }

    /** Classify this pod. When the server-authoritative [liveness] field is
     *  present (Fix A) it is TRUSTED — the phone no longer infers "online" from
     *  mere registration:
     *   - `LIVE`        → ONLINE.
     *   - `UNREACHABLE` → OFFLINE (a real heartbeat existed but went stale); a
     *                     live unlock/entitlement request overrides to
     *                     WAITING_FOR_APPROVAL (the box is actively trying to come up).
     *   - `NEVER`       → a live request wins (WAITING_FOR_APPROVAL); else still
     *                     COMING_ONLINE (awaiting first heartbeat, NOT dead).
     *  When [liveness] is absent (pre-field Worker / pending / demo), the legacy
     *  registration-derived path holds: ONLINE short-circuits on [cameOnline]; a
     *  live unlock request wins; a recent registration is COMING_ONLINE and an
     *  old one is DEAD; pending pods report COMING_ONLINE so they never read dead.
     *  Mirror of iOS PodInfo.livenessState. */
    fun livenessState(
        hasLiveUnlockRequest: Boolean,
        now: Long = System.currentTimeMillis(),
    ): LivenessState {
        liveness?.let {
            return when (it) {
                Liveness.LIVE -> LivenessState.ONLINE
                Liveness.UNREACHABLE ->
                    if (hasLiveUnlockRequest) LivenessState.WAITING_FOR_APPROVAL
                    else LivenessState.OFFLINE
                Liveness.NEVER ->
                    if (hasLiveUnlockRequest) LivenessState.WAITING_FOR_APPROVAL
                    else LivenessState.COMING_ONLINE
            }
        }
        if (status == Status.ONLINE && cameOnline) return LivenessState.ONLINE
        if (hasLiveUnlockRequest) return LivenessState.WAITING_FOR_APPROVAL
        if (status == Status.PENDING) return LivenessState.COMING_ONLINE
        val age = now - registeredAt
        if (registeredAt > 0 && age <= COMING_ONLINE_GRACE_MS) return LivenessState.COMING_ONLINE
        return LivenessState.DEAD
    }

    /** Humanized "last seen" for an [Liveness.UNREACHABLE] box, e.g. "2 hours
     *  ago" or "just now" — feeds the "offline — last seen <…>" copy. null ⇒ no
     *  reachability age available. Mirror of iOS PodInfo.humanizedLastSeen. */
    fun humanizedLastSeen(): String? {
        val ms = lastSeenMsAgo ?: return null
        if (ms < 0) return null
        return humanizeAge(ms)
    }

    companion object {
        /** Shared, locale-free age humanizer (mirrors iOS PodInfo.humanizeAge +
         *  the webapp `formatAge`). */
        fun humanizeAge(ms: Long): String {
            val sec = ms / 1000
            if (sec < 60) return "just now"
            val min = sec / 60
            if (min < 60) return "$min minute${if (min == 1L) "" else "s"} ago"
            val hr = min / 60
            if (hr < 24) return "$hr hour${if (hr == 1L) "" else "s"} ago"
            val day = hr / 24
            return "$day day${if (day == 1L) "" else "s"} ago"
        }

        /** #56 — deterministic, fqdn-derived pod id. Pod identity is UNIFIED
         *  on the normalized fqdn so a registered-`/pods` pod and a pending
         *  order for the same box key on the SAME id — no stuck-pending
         *  duplicate when a box goes live. An empty fqdn has no stable
         *  identity, so callers fall back to their own id in that case.
         *  Mirror of iOS PodInfo.podId(forFqdn:). */
        fun podId(fqdn: String): String = "pod-" + fqdn.lowercase()

        /** Shared grace window (ms) after registration during which a not-yet-
         *  online box reads "Coming online…" rather than "Never came online".
         *  20 minutes. Mirror of iOS PodInfo.comingOnlineGraceMs. */
        const val COMING_ONLINE_GRACE_MS: Long = 20L * 60L * 1000L
    }
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
