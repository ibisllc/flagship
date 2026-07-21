import Foundation
import Observation
import FlagshipAPI

/// W3 — durable profile descriptor. A "cloud" is what we used to call
/// a "username" — each cloud has one root key (today's IRK). One phone
/// can host multiple profiles (personal cloud + family cloud + work
/// cloud) and switch between them. The Phase F demo case is one
/// profile per phone; multi-profile is the v2 capability that makes
/// corporate / family setups work.
///
/// W8 NOTE: `cloudRootPubHex` is the IDENTITY of the cloud's root key;
/// the corresponding *private* IRK lives in the Keychain under the
/// `.cloudRoot` sync class (kSecAttrSynchronizable=true → iCloud
/// Keychain). Per-device device-IRKs (when we ship them) land under
/// `.deviceLocal` (kSecAttrSynchronizable=false) so a restored iPad
/// mints its own device key instead of cloning an existing device.
public struct Profile: Codable, Equatable, Sendable {
    public let cloudName: String
    public let cloudRootPubHex: String
    public let accountId: String
    public let deviceId: String
    /// OS-protected, account-scoped presentation cache. Never authoritative.
    public let accountDisplayName: String?
    public let deviceDisplayName: String?
    public let deviceCapability: DeviceCapabilityBlock?
    public let demoServer: DemoServerBlock?
    public let createdAt: Date

    public init(
        cloudName: String,
        cloudRootPubHex: String = "",
        accountId: String = "",
        deviceId: String = "",
        accountDisplayName: String? = nil,
        deviceDisplayName: String? = nil,
        deviceCapability: DeviceCapabilityBlock? = nil,
        demoServer: DemoServerBlock? = nil,
        createdAt: Date = Date()
    ) {
        self.cloudName = cloudName
        self.cloudRootPubHex = cloudRootPubHex
        self.accountId = accountId
        self.deviceId = deviceId
        self.accountDisplayName = accountDisplayName
        self.deviceDisplayName = deviceDisplayName
        self.deviceCapability = deviceCapability
        self.demoServer = demoServer
        self.createdAt = createdAt
    }
}

/// App-wide observable state. The single source of truth for "who is the
/// user, which servers do they own, which one is the leader."
///
/// `isPaired` gates the RootShell — when false, the OnboardingFlow is
/// presented as a full-screen cover. The first pod added is automatically
/// marked leader; users can change which pod is leader later from the
/// pod card context menu.
///
/// W3 multi-profile shape: in addition to the single-identity session
/// fields (`currentUser`, `pods`, `deviceCapability`, …), AppState
/// carries a `profiles` list + `activeProfileCloudName`. The
/// single-identity fields continue to reflect the ACTIVE profile;
/// existing callsites that read `currentUser` need no changes. The
/// Phase F demo case stays at one profile per phone.
@Observable
public final class AppState {
    public var isPaired: Bool
    public var currentUser: String?
    public var pods: [PodInfo]
    public var leaderPodId: String?
    /// Which pod's daemon the screens-client points at. Drives the
    /// per-pod-scoped lists (Apps, Activity, Server detail). Defaults
    /// to the leader. UI exposes the switcher only when pods.count > 1.
    public var currentPodId: String?
    /// True once the user has uploaded a WebAuthn-PRF cloud recovery
    /// envelope for the current account. Drives the Home / Activity
    /// nudge banner (B9) — visible when we have at least one online
    /// pod but no recovery yet. Stored in-memory rather than persisted
    /// because it's cheap to refresh on launch from .com, and we want
    /// the source of truth to be the server.
    public var hasCloudRecovery: Bool
    /// True once the user has tapped "Dismiss" on the recovery nudge
    /// in this app session. Banner re-appears next launch — this is
    /// not "permanent" dismiss; recovery is important enough that we
    /// re-surface the nudge until the user actually enrolls. The
    /// boolean lives in AppState (not the VM) so toggling it from
    /// Home doesn't disappear-then-reappear when the user switches
    /// to Activity and back.
    public var recoveryNudgeDismissedThisSession: Bool
    /// E7 — true once we've observed that this device's local push
    /// the current account-scoped device identity is rejected by an
    /// authenticated directory read, meaning another device ran a revoke,
    /// replace, or wipe operation against us.
    public var accountWasReset: Bool
    /// B12 — when true, the app requires a successful biometric
    /// evaluation at launch (and on resume from cold-background)
    /// before any content beyond the lock screen renders. Default
    /// false on the new account-create path; the user opts in from
    /// Settings → Privacy → Require Face ID. The setting is persisted
    /// to UserDefaults out-of-band (the persistence layer hands it
    /// in via the init).
    public var requireBiometricAtLaunch: Bool
    /// B12 — in-memory unlock latch. Flipped true after a successful
    /// BiometricGate.evaluate; flipped back to false when the app
    /// resigns active. Initial value depends on requireBiometricAtLaunch
    /// — if biometric isn't required, this is true by default so the
    /// content renders immediately.
    public var isUnlocked: Bool
    /// True when the lock screen was reached by an EXPLICIT user action (the
    /// Settings "Lock" button) rather than a launch/background relock. The lock
    /// screen suppresses its auto-Face-ID prompt in this case so a deliberate
    /// lock waits for the user to tap "Unlock with Face ID" — locking and then
    /// being instantly unlocked by an auto-prompt is pointless. Auto-prompt
    /// stays on for launch + return-from-background. Cleared on a successful
    /// unlock (`markUnlocked`).
    public var awaitingManualUnlock: Bool = false
    /// v2 device-addressing — the effective scopes the current device
    /// holds under the signed-in user. Nil ⇒ legacy single-IRK path,
    /// no restriction (treat as full scope set). When non-nil, the
    /// UI greys out actions absent from this set and renders the
    /// device-label chip below the username. See
    /// docs/v2-device-addressing-and-real-ticket.md §5.2.
    public var deviceCapability: DeviceCapabilityBlock?

    /// #43 — the set of opaque order refs (`OrderRef.compute(serial:)`,
    /// sha256 of the canonical-tagged serial) the unauthenticated `/pods`
    /// fetch last reported as live in-flight orders. The raw serial is a
    /// provision-status write capability, so the directory only ever ships
    /// the ref. Populated by the PendingServerReconciler; read by the
    /// PendingPodWatcher as a NON-biometric authority for "is this serial
    /// still a real order?" (it hashes its locally-stored serial and tests
    /// membership) so a wiped/expired serial stops spinning at "booting"
    /// instead of polling forever. Nil ⇒ never reconciled this session
    /// (the watcher keeps its legacy keep-waiting behaviour).
    public var lastKnownOutstandingOrderRefs: Set<String>?

    /// The Box Request Inbox (docs/box-request-inbox.md): ONE typed object,
    /// keyed by lowercased fqdn → the list of approvals that box is currently
    /// asking its owner for. Mirrors the backend's `/pods` `pendingRequests`
    /// digest (`[{id,type,issuedAt,expiresAt}]`) — `unlock-key` and `entitlement`
    /// are two `type` values in ONE inbox, not two parallel sets. Populated by
    /// ONE account-level poll (`BootApprovalWatcher`) so the list / card / detail
    /// read a per-server "what is it asking me?" without N pollers. Empty ⇒
    /// nothing waiting (or not polled yet this session). The legacy
    /// `hasLiveUnlockRequest` / `hasLiveEntitlementRequest` accessors are now
    /// DERIVED from this by filtering on `type`.
    public var boxRequestInbox: [String: [BoxRequest]] = [:]

    /// Every pending request across all of the owner's boxes, newest first —
    /// the flat inbox the inbox view renders from.
    public var boxRequests: [BoxRequest] {
        boxRequestInbox.values.flatMap { $0 }.sorted { $0.issuedAt > $1.issuedAt }
    }

    /// The pending requests for [fqdn] of a given type (case-folds the lookup).
    public func boxRequests(forFqdn fqdn: String, type: SecretPurpose) -> [BoxRequest] {
        (boxRequestInbox[fqdn.lowercased()] ?? []).filter { $0.type == type }
    }

    /// True iff [fqdn] has a live pending unlock request right now. Derived from
    /// the unified inbox (`type == .unlockKey`). The single bridge from the
    /// account-level inbox into the per-server liveness classifier.
    public func hasLiveUnlockRequest(forFqdn fqdn: String) -> Bool {
        !boxRequests(forFqdn: fqdn, type: .unlockKey).isEmpty
    }

    /// True iff [fqdn] is waiting for the owner to authorize it to serve.
    /// Derived from the unified inbox (`type == .entitlement`).
    public func hasLiveEntitlementRequest(forFqdn fqdn: String) -> Bool {
        !boxRequests(forFqdn: fqdn, type: .entitlement).isEmpty
    }

    /// Lowercased fqdns with a live request of [type] — the display set a view
    /// projects from the unified inbox (mirrors the old `serversAwaiting*`
    /// shape, now derived).
    public func serversAwaiting(_ type: SecretPurpose) -> Set<String> {
        Set(boxRequestInbox.compactMap { key, reqs in
            reqs.contains { $0.type == type } ? key : nil
        })
    }

    /// True when [pod] is actively waiting for an entitlement (serve-auth)
    /// approval. Mirrors `isAwaitingUnlock`; reads the account-level set.
    public func isAwaitingEntitlement(_ pod: PodInfo) -> Bool {
        hasLiveEntitlementRequest(forFqdn: pod.fqdn)
    }

    /// True when [pod] is actively waiting for a boot-unlock approval. The
    /// SINGLE source the UI must use — the status badge AND the per-server
    /// Approve card — so the two never disagree. It ORs two signals of
    /// different freshness: the per-pod `awaitingUnlock` flag (refreshed only
    /// by a full `/pods` reconcile) and the account-level Box Request Inbox
    /// (refreshed every 5s by `BootApprovalWatcher`). A box that STARTS
    /// waiting after the last full reconcile has a stale-false per-pod flag but
    /// a fresh set membership — reading the per-pod flag alone hid the Approve
    /// card on server-detail while Home still showed "waiting for approval".
    public func isAwaitingUnlock(_ pod: PodInfo) -> Bool {
        pod.awaitingUnlock || hasLiveUnlockRequest(forFqdn: pod.fqdn)
    }

    /// Liveness for [pod] using the account-level waiting set. Convenience over
    /// `PodInfo.livenessState(hasLiveUnlockRequest:)` so callsites don't repeat
    /// the set lookup.
    public func liveness(for pod: PodInfo) -> PodInfo.LivenessState {
        // The cheap directory `awaitingUnlock`/`awaitingEntitlement` flags OR the
        // watcher sets — any one means the box is actively waiting for an owner
        // approval, so it must not read as "never came online" (and the
        // decommission/delete must stay hidden). Folding entitlement in here is
        // what makes a box stuck on serve-authorization show "waiting for
        // approval" on Home instead of looking dead.
        return pod.livenessState(hasLiveUnlockRequest: isAwaitingApproval(pod))
    }

    /// True when [pod] is waiting for ANY owner approval — unlock OR entitlement.
    /// The single "don't classify this dead, surface the approval" signal.
    public func isAwaitingApproval(_ pod: PodInfo) -> Bool {
        isAwaitingUnlock(pod) || isAwaitingEntitlement(pod)
    }

    /// W3 — durable list of clouds this phone is a member of. The
    /// single-identity `currentUser` / `pods` / `deviceCapability`
    /// fields reflect the ACTIVE profile (the one the rest of the UI
    /// currently renders). Empty in the unpaired state.
    public var profiles: [Profile]
    /// W3 — `cloudName` of the entry in `profiles` whose session state
    /// is mirrored into `currentUser` / `pods` / `deviceCapability`.
    /// Nil ⇒ no active profile (unpaired, or every profile was wiped).
    public var activeProfileCloudName: String?

    /// iOS-side hook to keep the per-profile keystore (UMK/IRK key
    /// slots) aligned with the active cloud. Wired by the iPhone app at
    /// boot — the iOS shell injects a closure that calls
    /// `Keystore.setActiveProfile(cloudName)` from the iOS-only
    /// `Flagship` SPM target. Left unset on watchOS (no keystore on the
    /// watch); the AppState mutations themselves are fully cross-platform.
    public var onActiveProfileChanged: ((String) -> Void)?

    public init(
        isPaired: Bool = false,
        currentUser: String? = nil,
        pods: [PodInfo] = [],
        leaderPodId: String? = nil,
        currentPodId: String? = nil,
        hasCloudRecovery: Bool = true,
        recoveryNudgeDismissedThisSession: Bool = false,
        accountWasReset: Bool = false,
        requireBiometricAtLaunch: Bool = false,
        isUnlocked: Bool? = nil,
        deviceCapability: DeviceCapabilityBlock? = nil,
        profiles: [Profile] = [],
        activeProfileCloudName: String? = nil
    ) {
        self.isPaired = isPaired
        self.currentUser = currentUser
        self.pods = pods
        self.leaderPodId = leaderPodId
        self.currentPodId = currentPodId ?? leaderPodId ?? pods.first?.podId
        self.hasCloudRecovery = hasCloudRecovery
        self.recoveryNudgeDismissedThisSession = recoveryNudgeDismissedThisSession
        self.accountWasReset = accountWasReset
        self.requireBiometricAtLaunch = requireBiometricAtLaunch
        // Default isUnlocked: if biometric isn't required, start
        // unlocked. If required, start LOCKED (the gate view shows).
        self.isUnlocked = isUnlocked ?? !requireBiometricAtLaunch
        self.deviceCapability = deviceCapability
        self.profiles = profiles
        self.activeProfileCloudName = activeProfileCloudName ?? profiles.first(where: { $0.cloudName == currentUser })?.cloudName
    }

    /// W3 — the active Profile, or nil if none is active. Convenience
    /// for surfaces that want the full account-scoped descriptor,
    /// demoServer, createdAt) and not just the cloud name.
    public var activeProfile: Profile? {
        guard let name = activeProfileCloudName else { return nil }
        return profiles.first(where: { $0.cloudName == name })
    }

    /// v2 device-addressing — true iff the current device is a
    /// restricted sub-identity (has a deviceCapability with a partial
    /// scope set). UI uses this to gate the chip + tooltips. A nil
    /// capability or a fully-scoped one render NO chip and NO
    /// tooltips (legacy single-IRK behaviour).
    public var isRestrictedDevice: Bool {
        guard let cap = deviceCapability else { return false }
        return !cap.isFullyScoped
    }

    /// v2 device-addressing — quick lookup helper. Returns true when
    /// the device's scopes cover [scope] (or when no capability is
    /// installed at all — the legacy single-IRK path holds every
    /// scope implicitly). UI callsites use this to enable / disable
    /// individual buttons.
    public func hasScope(_ scope: DeviceScope) -> Bool {
        guard let cap = deviceCapability else { return true }
        return cap.scopeSet.contains(scope)
    }

    /// True when the recovery-setup nudge should be visible on Home /
    /// Activity. Conditions:
    ///   - at least one ONLINE pod (so the user is past day-0 onboarding
    ///     and into "I'm running my own cloud" territory);
    ///   - cloud recovery NOT yet enrolled;
    ///   - the user hasn't dismissed the nudge this session.
    /// The check is cheap and pure; UI calls it every render.
    public var shouldShowRecoveryNudge: Bool {
        guard !hasCloudRecovery else { return false }
        guard !recoveryNudgeDismissedThisSession else { return false }
        return pods.contains(where: { $0.status == .online })
    }

    public var leaderPod: PodInfo? {
        guard let id = leaderPodId else { return nil }
        return pods.first(where: { $0.podId == id })
    }

    /// DETERMINISTIC FALLBACK (Fix C) — the OLDEST pod. `.com` returns `/pods`
    /// oldest-first, so `pods.first` IS the oldest. The UI default pod / leader
    /// must NEVER silently float to a brand-new box (= whatever appeared first in
    /// some other ordering); when an explicit anchor is missing or dangling, it
    /// re-anchors HERE — the stable, oldest pod — so adding a server can't seize
    /// the default. nil only when there are no pods.
    private var oldestPod: PodInfo? { pods.first }

    public var currentPod: PodInfo? {
        if let id = currentPodId, let p = pods.first(where: { $0.podId == id }) { return p }
        // The leader is the UI default. If it resolves, use it; otherwise fall
        // back to the OLDEST pod (deterministic) — NOT `pods.first` "by accident"
        // and never the newest box.
        return leaderPod ?? oldestPod
    }

    /// The GLOBAL anchor pod for Home/Services (the default box session). Unlike
    /// `currentPod` — which resolves to the LEADER and thus, by default, the
    /// OLDEST pod regardless of liveness — this prefers a genuinely-LIVE pod
    /// (HONEST LIVENESS, Fix A: `.status == .online` now means a real heartbeat,
    /// not mere registration). A registered-but-dead/unreachable pod that happens
    /// to be the leader must NOT anchor the global session: the selected pod if
    /// it's online, else the first online pod; nil when no pod is online (the
    /// per-pod detail still targets its own box deterministically via the fqdn).
    public var sessionPod: PodInfo? {
        if let p = currentPod, p.status == .online { return p }
        return pods.first(where: { $0.status == .online })
    }

    public func completeOnboarding(username: String, pods: [PodInfo]) {
        self.currentUser = username
        self.pods = pods
        // The genuine first anchor: the OLDEST pod (`pods.first` — `.com` returns
        // `/pods` oldest-first). This is the only place leadership is seeded from
        // the list; thereafter it's STICKY (Fix C) — `addPod` never re-seeds it,
        // so a later box can't seize the default.
        self.leaderPodId = pods.first?.podId
        self.currentPodId = pods.first?.podId
        self.isPaired = true
        // W3 — record the cloud in the durable profile list and mark
        // it active. Idempotent: re-running onboarding for an already
        // known cloud refreshes its capability/demoServer/createdAt
        // rather than appending a duplicate.
        let existing = profiles.first(where: { $0.cloudName == username })
        let generatedDeviceId = (try? AccountMetadata.generateDeviceId()) ?? "00000000000000000000000000000000"
        upsertProfile(Profile(
            cloudName: username,
            cloudRootPubHex: "",
            accountId: username,
            deviceId: deviceCapability?.deviceId ?? existing?.deviceId ?? generatedDeviceId,
            accountDisplayName: existing?.accountDisplayName,
            deviceDisplayName: existing?.deviceDisplayName,
            deviceCapability: deviceCapability,
            demoServer: nil,
            createdAt: Date()
        ))
        self.activeProfileCloudName = username
        // Keep the keystore's active-profile pointer aligned with the
        // onboarded cloud (the add-profile VMs already point it before
        // key-gen; this covers re-onboarding / switch-back paths).
        onActiveProfileChanged?(username)
    }

    /// Restore a previously paired session on cold launch. The iOS shell
    /// calls this when the Keystore still holds a wrapped UMK — a real
    /// identity that survives app restarts — so the user lands on the
    /// (biometric-gated) shell instead of re-running a full sign-in.
    /// Pods are intentionally left empty; the tabs fetch them fresh from
    /// `/devices`. No-op if a session is already active (smoke mode /
    /// a live pairing wins). Demo/mock sessions never wrap a UMK, so the
    /// shell never calls this for them — they fall through to Welcome.
    public func restorePersistedSession(username: String) {
        guard !isPaired else { return }
        completeOnboarding(username: username, pods: [])
    }

    /// W3 — register a new profile (or refresh an existing one with the
    /// same `cloudName`) and set it active.
    public func addProfile(_ profile: Profile, setActive: Bool = true) {
        upsertProfile(profile)
        if setActive {
            setActiveProfile(profile.cloudName)
        }
    }

    /// W3 — switch the active profile. Mirrors the chosen profile's
    /// session state into the single-identity fields so callsites
    /// reading `currentUser` / `deviceCapability` see the new cloud.
    /// Pods are NOT carried across — switching profiles drops the
    /// pod list (the new cloud's pods are fetched fresh from /devices).
    /// No-op if `cloudName` isn't in `profiles`.
    public func setActiveProfile(_ cloudName: String) {
        guard let p = profiles.first(where: { $0.cloudName == cloudName }) else { return }
        self.activeProfileCloudName = cloudName
        self.currentUser = p.cloudName
        self.deviceCapability = p.deviceCapability
        self.pods = []
        self.leaderPodId = nil
        self.currentPodId = nil
        self.isPaired = true
        // Per-profile keystore keying: point UMK/IRK derivation at this
        // profile's slot so deriveIRK / unwrapUMK target the active cloud.
        // The profileId is the cloudName lowercased (Keystore normalizes).
        // Wired by the iOS shell via onActiveProfileChanged; the watch
        // app leaves the hook unset.
        onActiveProfileChanged?(p.cloudName)
    }

    private func upsertProfile(_ profile: Profile) {
        if let idx = profiles.firstIndex(where: { $0.cloudName == profile.cloudName }) {
            profiles[idx] = profile
        } else {
            profiles.append(profile)
        }
    }

    public func cachePresentationNames(accountDisplayName: String, deviceDisplayName: String?) {
        guard let active = activeProfile else { return }
        upsertProfile(Profile(
            cloudName: active.cloudName,
            cloudRootPubHex: active.cloudRootPubHex,
            accountId: active.accountId,
            deviceId: active.deviceId,
            accountDisplayName: accountDisplayName,
            deviceDisplayName: deviceDisplayName ?? active.deviceDisplayName,
            deviceCapability: active.deviceCapability,
            demoServer: active.demoServer,
            createdAt: active.createdAt
        ))
    }

    public func addPod(_ pod: PodInfo) {
        pods.append(pod)
        // STICKY LEADERSHIP (Fix C) — a newly-added box must NEVER change the
        // leader / default pod. A new server auto-seizing leadership was the
        // reported bug ("frank seized leadership"). We seed leader/current ONLY
        // when none is set yet (the genuine first-pod / cold-restore case); an
        // existing leader is left exactly as it is, so the new box is just
        // another selectable pod — not the new default.
        if leaderPodId == nil { leaderPodId = pod.podId }
        if currentPodId == nil { currentPodId = pod.podId }
    }

    /// Idempotent insert of a pending pod, keyed on the fqdn (the same
    /// identity rule as `upsertRegisteredPod`). The create flow fires this
    /// the moment an order is DELIVERED — not when the user taps "Done" —
    /// so the pod can already exist: surfaced serial-less by the `/pods`
    /// reconciler (the unauthenticated directory never carries the raw
    /// serial), or re-fired by the delivered page re-appearing. Merging
    /// attaches this device's locally-known auth-code serial to a
    /// serial-less twin, restoring the deep-progress/cancel capability the
    /// order's creator owns; a known serial is never downgraded to nil and
    /// an online pod always wins. Returns the resolved pod id.
    @discardableResult
    public func upsertPendingPod(
        name: String,
        description: String? = nil,
        fqdn: String,
        serial: String?
    ) -> String {
        let target = fqdn.lowercased()
        let newSerial = (serial?.isEmpty == false) ? serial : nil
        if !target.isEmpty,
           let idx = pods.firstIndex(where: { $0.fqdn.lowercased() == target }) {
            let old = pods[idx]
            if old.status == .online { return old.podId }
            pods[idx] = PodInfo(
                podId: old.podId,
                name: name.isEmpty ? old.name : name,
                description: (description?.isEmpty == false) ? description : old.description,
                fqdn: old.fqdn,
                status: .pending,
                pendingAuthCodeSerial: newSerial ?? old.pendingAuthCodeSerial
            )
            return old.podId
        }
        let podId = fqdn.isEmpty
            ? "pod-\(UUID().uuidString.prefix(6).lowercased())"
            : PodInfo.podId(forFqdn: fqdn)
        addPod(PodInfo(
            podId: podId,
            name: name,
            description: (description?.isEmpty == false) ? description : nil,
            fqdn: fqdn,
            status: .pending,
            pendingAuthCodeSerial: newSerial
        ))
        return podId
    }

    /// Registration is AUTHORITATIVE for online. A server present in the
    /// registered `/pods` inventory is rendered `.online` regardless of any
    /// heartbeat / cert side-channel — those aren't populated for a
    /// content-blind `.com` or a just-live box, so leaning on them stranded
    /// a live server as Pending. Identity is unified on the fqdn: if a pod
    /// (pending or otherwise) already exists for this fqdn, it's flipped to
    /// `.online` in place (preserving leader/current selection); otherwise a
    /// fresh `.online` pod is added. The online pod always wins over a
    /// pending duplicate sharing the fqdn. Returns the resolved pod id.
    @discardableResult
    public func upsertRegisteredPod(
        fqdn: String,
        name: String,
        description: String? = nil,
        cameOnline: Bool = true,
        registeredAt: Int64 = 0,
        awaitingUnlock: Bool = false,
        liveness: PodInfo.Liveness? = nil,
        lastSeenMsAgo: Int64? = nil,
        lastReported: Int64? = nil,
        identityPubKeyHex: String = "",
        leadsServices: [String] = []
    ) -> String {
        // HONEST LIVENESS (Fix A) — derive the pod's status from the
        // server-authoritative `liveness` field instead of trusting that a
        // registered box is `.online`. `.live` → online; `.unreachable` →
        // offline (a previously-live box now stale); `.never` → unknown
        // (registered, awaiting its first heartbeat — NOT session-eligible, so
        // it can't anchor a box session or be picked as a live leader). When
        // `.com` didn't send the field (pre-field Worker), fall back to the
        // legacy registration-is-online behavior.
        let derivedStatus: PodInfo.Status
        switch liveness {
        case .live:        derivedStatus = .online
        case .unreachable: derivedStatus = .offline
        case .never:       derivedStatus = .unknown
        case nil:          derivedStatus = .online
        }
        let target = fqdn.lowercased()
        if let idx = pods.firstIndex(where: { $0.fqdn.lowercased() == target }) {
            let old = pods[idx]
            // Already at the derived liveness with a confirmed check-in AND not
            // waiting AND the liveness signal hasn't changed — nothing to do
            // (don't clobber a richer name). A box whose reachability changed,
            // came online, or is now waiting for an approval is re-flowed below.
            if old.status == derivedStatus && old.cameOnline && !awaitingUnlock
                && old.liveness == liveness && old.lastSeenMsAgo == lastSeenMsAgo
                && old.leadsServices == leadsServices {
                return old.podId
            }
            pods[idx] = PodInfo(
                podId: old.podId,
                name: old.name.isEmpty ? name : old.name,
                description: old.description ?? description,
                fqdn: old.fqdn,
                status: derivedStatus,
                pendingAuthCodeSerial: nil,
                cameOnline: cameOnline,
                // Keep a known registration time; never downgrade to 0.
                registeredAt: registeredAt > 0 ? registeredAt : old.registeredAt,
                awaitingUnlock: awaitingUnlock,
                liveness: liveness,
                lastSeenMsAgo: lastSeenMsAgo,
                lastReported: lastReported ?? old.lastReported,
                // Keep a known STK; never downgrade to empty on a sparse update.
                identityPubKeyHex: identityPubKeyHex.isEmpty ? old.identityPubKeyHex : identityPubKeyHex,
                leadsServices: leadsServices
            )
            return old.podId
        }
        let id = PodInfo.podId(forFqdn: fqdn)
        addPod(PodInfo(
            podId: id,
            name: name,
            description: description,
            fqdn: fqdn,
            status: derivedStatus,
            cameOnline: cameOnline,
            registeredAt: registeredAt,
            awaitingUnlock: awaitingUnlock,
            liveness: liveness,
            lastSeenMsAgo: lastSeenMsAgo,
            lastReported: lastReported,
            identityPubKeyHex: identityPubKeyHex,
            leadsServices: leadsServices
        ))
        return id
    }

    public func setLeader(_ podId: String) {
        guard pods.contains(where: { $0.podId == podId }) else { return }
        leaderPodId = podId
    }

    public func setCurrentPod(_ podId: String) {
        guard pods.contains(where: { $0.podId == podId }) else { return }
        currentPodId = podId
    }

    /// PREFER a fresher, box-direct leadership view over the `.com` `/pods`
    /// relay (Phase 6). `directByFqdn` is the inverted per-pod model
    /// (lowercased fqdn → the slugs that box leads) produced from a box's
    /// `GET /api/leads` (see `DirectLeadsInversion`). For each known pod we
    /// OVERRIDE its `leadsServices` with the direct value — including an empty
    /// list, so a box that just YIELDED a service stops showing the stale relay
    /// badge. A pod absent from the map keeps its relay value untouched (we
    /// learned nothing fresher about it), so this never regresses and is a
    /// pure no-op when the map is empty. Best-effort: call it only with the
    /// result of a SUCCESSFUL direct read; on any fetch failure the caller
    /// simply doesn't call this and the relay value stands.
    public func applyDirectLeads(_ directByFqdn: [String: [String]]) {
        guard !directByFqdn.isEmpty else { return }
        for idx in pods.indices {
            let key = pods[idx].fqdn.lowercased()
            guard let slugs = directByFqdn[key] else { continue }
            if pods[idx].leadsServices == slugs { continue }
            let old = pods[idx]
            pods[idx] = PodInfo(
                podId: old.podId,
                name: old.name,
                description: old.description,
                fqdn: old.fqdn,
                status: old.status,
                pendingAuthCodeSerial: old.pendingAuthCodeSerial,
                demoServer: old.demoServer,
                cameOnline: old.cameOnline,
                registeredAt: old.registeredAt,
                awaitingUnlock: old.awaitingUnlock,
                liveness: old.liveness,
                lastSeenMsAgo: old.lastSeenMsAgo,
                lastReported: old.lastReported,
                identityPubKeyHex: old.identityPubKeyHex,
                leadsServices: slugs
            )
        }
    }

    public func removePod(_ podId: String) {
        pods.removeAll { $0.podId == podId }
        // DETERMINISTIC RE-ANCHOR (Fix C) — when the removed pod WAS the leader,
        // the leader dangles. Re-anchor explicitly to the OLDEST remaining pod
        // (`oldestPod`, = `pods.first` since `.com` returns oldest-first) rather
        // than letting `currentPod` silently float to whatever happens to be
        // first. A non-leader removal leaves the leader untouched (sticky).
        if leaderPodId == podId { leaderPodId = oldestPod?.podId }
        if currentPodId == podId { currentPodId = leaderPodId ?? oldestPod?.podId }
    }

    public func signOut() {
        self.isPaired = false
        self.currentUser = nil
        self.pods = []
        self.leaderPodId = nil
        self.currentPodId = nil
        self.deviceCapability = nil
        self.activeProfileCloudName = nil
        // Welcome doesn't need the lock-screen gate (the user is
        // about to authenticate via passkey anyway). Keep the user
        // preference for next launch; just unlock the runtime latch.
        self.isUnlocked = true
    }

    /// B12 — call when the user successfully unlocks via biometric.
    /// Doesn't mutate requireBiometricAtLaunch (that's user-pref);
    /// flips the in-memory latch so content renders this session.
    public func markUnlocked() {
        isUnlocked = true
        awaitingManualUnlock = false
    }

    /// Tier 1 — LOCK. Explicitly re-gate the app behind the biometric
    /// lock screen WITHOUT touching anything else: the Keychain key
    /// material, the active session, the pod list — all stay exactly as
    /// they are. This is the cheapest of the three "leave the app"
    /// actions: a snoop who picks up the phone sees the lock screen, and
    /// the user re-enters with Face ID via the existing BiometricLockScreen.
    ///
    /// Unlike `relockForBackground()`, this does NOT consult
    /// `requireBiometricAtLaunch` — locking explicitly is a deliberate
    /// user action and must always re-gate, even when the auto-lock-on-
    /// launch preference is off. The lock screen's unlock button drives
    /// `markUnlocked()` to come back.
    public func lock() {
        isUnlocked = false
        // Deliberate lock ⇒ the lock screen must WAIT for an explicit
        // "Unlock with Face ID" tap, not auto-prompt and instantly undo the lock.
        awaitingManualUnlock = true
    }

    /// B12 — call from the SceneDelegate / SwiftUI .scenePhase change
    /// when the app moves to .background. Re-locks the latch so the
    /// next foreground re-shows the gate.
    public func relockForBackground() {
        guard requireBiometricAtLaunch else { return }
        isUnlocked = false
    }
}

/// A single server pod. `name` is the user-facing short label
/// (e.g. "Home"); `description` is a longer one-liner ("Failover for
/// work", "Music projects") shown wherever the FQDN used to live.
/// The FQDN itself is technical and lives only in detail views.
public struct PodInfo: Identifiable, Hashable, Sendable {
    public enum Status: String, Sendable, Hashable {
        case online, offline, unknown
        /// Order has been delivered through the QR relay but the box
        /// hasn't booted + phoned home yet. Renders with a Pending pill
        /// and a placeholder detail page (instructions + cancel).
        case pending
    }

    public let podId: String
    public let name: String
    public let description: String?
    public let fqdn: String
    public let status: Status
    /// False for a server that registered its STK during install but whose
    /// daemon has NEVER checked in (no `lastReported`, no cert in `/pods`) —
    /// a "registered but never came online" box. Defaults true so every
    /// other path (pending pods, live pods, the create flow) is unaffected;
    /// only the reconciler flips it false from the directory derivation. The
    /// UI uses it to mark the pod "Never came online" and to offer the
    /// decommission/free-the-name delete instead of the lost/stolen revoke.
    public let cameOnline: Bool

    /// Wall-clock ms the box's registration was admitted (from `/pods`
    /// `registeredAt`). Drives the "coming online" grace window: a box that
    /// registered RECENTLY but hasn't checked in yet is provisioning, not dead.
    /// 0 ⇒ unknown / not registered (pending pods, demo, a pre-field Worker) —
    /// treated as "no grace" so a genuinely-old dead box is never masked.
    public let registeredAt: Int64

    /// Shared grace window (ms) after registration during which a not-yet-
    /// online box reads "Coming online…" rather than "Never came online".
    /// 20 minutes — long enough to cover a slow first boot + LUKS unlock, short
    /// enough that a genuinely-dead box flips to the deletable state. Mirrored
    /// in Android `PodInfo.COMING_ONLINE_GRACE_MS`.
    public static let comingOnlineGraceMs: Int64 = 20 * 60 * 1000

    /// Deterministic, fqdn-derived pod id. Pod identity is UNIFIED on the
    /// normalized fqdn so the registered-`/pods` pod, the outstanding-orders
    /// reconciler's pod, the pending-pod watcher's flip, and the
    /// PendingServerStore record all key on the SAME id for a given server —
    /// no stuck-pending duplicate when a box goes live (a registered pod and a
    /// pending pod that share an fqdn collapse to one). An empty fqdn (a
    /// pre-delivery pending pod that has no predicted domain yet) has no
    /// stable identity, so callers fall back to their own id in that case.
    public static func podId(forFqdn fqdn: String) -> String {
        "pod-" + fqdn.lowercased()
    }
    /// For pods in `.pending` status, the auth-code serial issued at
    /// CreateServer time. Lets Cancel-order revoke the auth-code on
    /// flagshipserver.com instead of just removing the pod locally.
    public let pendingAuthCodeSerial: String?
    /// For demo-mode pods (Plan A), the latest demoServer block backing
    /// this device. Carries the provisioning `phase` + device-identifying
    /// metadata (ip/region/serverType/image) so the Home list can render
    /// a thin progress bar and the detail page can show the step list +
    /// the device info block. Nil for non-demo pods.
    public let demoServer: DemoServerBlock?
    public var id: String { podId }

    /// Cheap, non-biometric "this box is waiting for a boot-unlock approval
    /// right now" flag, straight from the `/pods` directory (`awaitingUnlock`).
    /// A locked box can't reach its daemon BFF and won't heartbeat, so without
    /// this it would read "Never came online" past the grace window; the phone's
    /// only other signal (the IRK mailbox read) is biometric and can't poll
    /// unattended. Feeds the liveness classifier so a waiting box reads
    /// "waiting for approval" (and the dangerous decommission/delete stays
    /// hidden). Defaults false (pending/demo/pre-field-Worker pods).
    public let awaitingUnlock: Bool

    /// HONEST LIVENESS — the server-authoritative reachability classification
    /// from the `/pods` directory (`liveness: "live" | "unreachable" | "never"`).
    /// `.com` computes this from the box's daemon-status heartbeat against a
    /// freshness window — so the phone STOPS trusting mere registration as
    /// "online". nil ⇒ a pre-field Worker response that didn't carry the field
    /// (the reconciler falls back to registration-derived `cameOnline`).
    ///   - `.live`        → the box is reachable (heartbeat within the window).
    ///   - `.unreachable` → it checked in before but has now gone stale/offline.
    ///   - `.never`       → registered but never sent a real heartbeat — still
    ///                      coming up / awaiting first heartbeat, NOT dead.
    public let liveness: Liveness?

    /// Wall-clock ms since the box's last daemon-status check-in, from `/pods`
    /// (`lastSeenMsAgo`). Humanized into "offline — last seen <…>" when the box
    /// is `.unreachable`. nil ⇒ never checked in (or a pre-field Worker).
    public let lastSeenMsAgo: Int64?

    /// Wall-clock ms of the box's last daemon-status check-in (`lastReported`
    /// from `/pods`), threaded for completeness. nil ⇒ never reported.
    public let lastReported: Int64?

    /// The box's registered STK (its identity pubkey, hex) from `/pods`
    /// (`identityPubKey`). Threaded onto the model so the "Set as preferred
    /// server" owner vote can name THIS box's STK (`preferredStkPubHex`) without
    /// a second directory fetch. Empty for pending/demo pods (no registration).
    public let identityPubKeyHex: String

    /// Per-service leadership (Phase 6) — the service slugs this box currently
    /// LEADS, relayed verbatim from `/pods` (`leadsServices`). Additive + tolerant
    /// of absence: empty when `.com` didn't carry it (pre-field Worker) or the box
    /// leads nothing. Surfaced as a small "lead" indicator on the server card.
    public let leadsServices: [String]

    /// Server-authoritative reachability, mirroring `.com`'s `/pods` `liveness`.
    public enum Liveness: String, Sendable, Hashable {
        case live, unreachable, never
    }

    public init(
        podId: String,
        name: String,
        description: String? = nil,
        fqdn: String,
        status: Status = .unknown,
        pendingAuthCodeSerial: String? = nil,
        demoServer: DemoServerBlock? = nil,
        cameOnline: Bool = true,
        registeredAt: Int64 = 0,
        awaitingUnlock: Bool = false,
        liveness: Liveness? = nil,
        lastSeenMsAgo: Int64? = nil,
        lastReported: Int64? = nil,
        identityPubKeyHex: String = "",
        leadsServices: [String] = []
    ) {
        self.podId = podId
        self.name = name
        self.description = description
        self.fqdn = fqdn
        self.status = status
        self.pendingAuthCodeSerial = pendingAuthCodeSerial
        self.demoServer = demoServer
        self.cameOnline = cameOnline
        self.registeredAt = registeredAt
        self.awaitingUnlock = awaitingUnlock
        self.liveness = liveness
        self.lastSeenMsAgo = lastSeenMsAgo
        self.lastReported = lastReported
        self.identityPubKeyHex = identityPubKeyHex
        self.leadsServices = leadsServices
    }

    /// Derived per-server liveness — the single classifier the list, the
    /// detail page, and the post-creation checklist share. `hasLiveUnlockRequest`
    /// is the account-level signal (a pending unlock-key request for this box's
    /// fqdn in the identity-plane mailbox) supplied by the caller; `now` is
    /// injectable for tests.
    public enum LivenessState: Equatable, Sendable {
        /// Daemon checked in (or holds a cert) — a live server.
        case online
        /// A live unlock request exists for this box: it's actively trying to
        /// boot and waiting for the owner's approval. NOT dead.
        case waitingForApproval
        /// Registered recently, no live request yet, still inside the grace
        /// window — provisioning, not dead.
        case comingOnline
        /// Registered, no live request, no check-in, and past the grace window
        /// — the box genuinely never came online. Offer the free-the-name delete.
        case dead
        /// HONEST LIVENESS — the box HAS checked in before but its heartbeat has
        /// gone stale (server-authoritative `liveness == "unreachable"`). Unlike
        /// `.dead` (never came online) this is a previously-live box that's now
        /// offline; the UI shows "offline — last seen <…>", NOT the decommission
        /// path. Reachable again on the next live heartbeat.
        case offline
    }

    /// Classify a registered/pending pod. When the server-authoritative
    /// `liveness` field is present (Fix A) it is TRUSTED — the phone no longer
    /// infers "online" from mere registration:
    ///   - `.live`        → `.online`.
    ///   - `.unreachable` → `.offline` (a real heartbeat existed but went stale).
    ///   - `.never`       → a live request wins (waitingForApproval); else still
    ///                      `.comingOnline` (awaiting first heartbeat, NOT dead).
    /// When `liveness` is absent (pre-field Worker / pending / demo), the legacy
    /// registration-derived path holds: `online` short-circuits on `cameOnline`;
    /// a live unlock request wins; a recent registration is `comingOnline`, an
    /// old one `dead`; pending (pre-registration) pods read `comingOnline`.
    public func livenessState(
        hasLiveUnlockRequest: Bool,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> LivenessState {
        if let liveness {
            switch liveness {
            case .live: return .online
            case .unreachable:
                // A box stuck waiting for an owner approval (boot-unlock /
                // entitlement) is actively trying to come up — surface the
                // approval rather than reading it as merely offline.
                if hasLiveUnlockRequest { return .waitingForApproval }
                return .offline
            case .never:
                if hasLiveUnlockRequest { return .waitingForApproval }
                return .comingOnline
            }
        }
        if status == .online && cameOnline { return .online }
        if hasLiveUnlockRequest { return .waitingForApproval }
        if status == .pending { return .comingOnline }
        let age = now - registeredAt
        if registeredAt > 0 && age <= PodInfo.comingOnlineGraceMs { return .comingOnline }
        return .dead
    }

    /// Humanized "last seen" for an `.unreachable` box, e.g. "2 hours" or
    /// "just now" — feeds the "offline — last seen <…>" copy. nil ⇒ no
    /// reachability age available.
    public func humanizedLastSeen() -> String? {
        guard let ms = lastSeenMsAgo, ms >= 0 else { return nil }
        return PodInfo.humanizeAge(ms)
    }

    /// Shared, locale-free age humanizer (mirrors the webapp `formatAge`).
    public static func humanizeAge(_ ms: Int64) -> String {
        let sec = ms / 1000
        if sec < 60 { return "just now" }
        let min = sec / 60
        if min < 60 { return "\(min) minute\(min == 1 ? "" : "s") ago" }
        let hr = min / 60
        if hr < 24 { return "\(hr) hour\(hr == 1 ? "" : "s") ago" }
        let day = hr / 24
        return "\(day) day\(day == 1 ? "" : "s") ago"
    }
}
