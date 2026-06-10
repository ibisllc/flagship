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
    public let deviceLabel: String?
    public let deviceCapability: DeviceCapabilityBlock?
    public let demoServer: DemoServerBlock?
    public let createdAt: Date

    public init(
        cloudName: String,
        cloudRootPubHex: String = "",
        deviceLabel: String? = nil,
        deviceCapability: DeviceCapabilityBlock? = nil,
        demoServer: DemoServerBlock? = nil,
        createdAt: Date = Date()
    ) {
        self.cloudName = cloudName
        self.cloudRootPubHex = cloudRootPubHex
        self.deviceLabel = deviceLabel
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
    /// tokenId is no longer in /api/users/:u/devices, meaning another
    /// device on the account ran a Disconnect / Replace / Wipe against
    /// us. The Home banner uses this to render a danger card with a
    /// "Sign in again" CTA. Default false — set by the detector after
    /// a successful round-trip.
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

    /// Lowercased fqdns of servers that currently have a LIVE pending boot-
    /// unlock request in the identity-plane mailbox (a box waiting for the
    /// owner's approval). Populated by ONE account-level poll
    /// (`BootApprovalWatcher`) so the list / card / detail can read a per-server
    /// "is it waiting for me?" without N pollers. Empty ⇒ none waiting (or not
    /// polled yet this session).
    public var serversAwaitingApproval: Set<String> = []

    /// True iff [fqdn] has a live pending unlock request right now. Case-folds
    /// the lookup. The single bridge from the account-level set into the
    /// per-server liveness classifier.
    public func hasLiveUnlockRequest(forFqdn fqdn: String) -> Bool {
        serversAwaitingApproval.contains(fqdn.lowercased())
    }

    /// Liveness for [pod] using the account-level waiting set. Convenience over
    /// `PodInfo.livenessState(hasLiveUnlockRequest:)` so callsites don't repeat
    /// the set lookup.
    public func liveness(for pod: PodInfo) -> PodInfo.LivenessState {
        pod.livenessState(hasLiveUnlockRequest: hasLiveUnlockRequest(forFqdn: pod.fqdn))
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
    /// for surfaces that want the full descriptor (deviceLabel,
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

    public var currentPod: PodInfo? {
        if let id = currentPodId, let p = pods.first(where: { $0.podId == id }) { return p }
        return leaderPod ?? pods.first
    }

    public func completeOnboarding(username: String, pods: [PodInfo]) {
        self.currentUser = username
        self.pods = pods
        self.leaderPodId = pods.first?.podId
        self.currentPodId = pods.first?.podId
        self.isPaired = true
        // W3 — record the cloud in the durable profile list and mark
        // it active. Idempotent: re-running onboarding for an already
        // known cloud refreshes its capability/demoServer/createdAt
        // rather than appending a duplicate.
        upsertProfile(Profile(
            cloudName: username,
            cloudRootPubHex: "",
            deviceLabel: deviceCapability?.label,
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

    public func addPod(_ pod: PodInfo) {
        pods.append(pod)
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
        registeredAt: Int64 = 0
    ) -> String {
        let target = fqdn.lowercased()
        if let idx = pods.firstIndex(where: { $0.fqdn.lowercased() == target }) {
            let old = pods[idx]
            // Already online with a confirmed check-in — nothing to do (don't
            // clobber a richer name). A previously-dead pod that has since come
            // online must still be re-flowed below so its pill clears.
            if old.status == .online && old.cameOnline { return old.podId }
            pods[idx] = PodInfo(
                podId: old.podId,
                name: old.name.isEmpty ? name : old.name,
                description: old.description ?? description,
                fqdn: old.fqdn,
                status: .online,
                pendingAuthCodeSerial: nil,
                cameOnline: cameOnline,
                // Keep a known registration time; never downgrade to 0.
                registeredAt: registeredAt > 0 ? registeredAt : old.registeredAt
            )
            return old.podId
        }
        let id = PodInfo.podId(forFqdn: fqdn)
        addPod(PodInfo(
            podId: id,
            name: name,
            description: description,
            fqdn: fqdn,
            status: .online,
            cameOnline: cameOnline,
            registeredAt: registeredAt
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

    public func removePod(_ podId: String) {
        pods.removeAll { $0.podId == podId }
        if leaderPodId == podId { leaderPodId = pods.first?.podId }
        if currentPodId == podId { currentPodId = leaderPodId ?? pods.first?.podId }
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

    public init(
        podId: String,
        name: String,
        description: String? = nil,
        fqdn: String,
        status: Status = .unknown,
        pendingAuthCodeSerial: String? = nil,
        demoServer: DemoServerBlock? = nil,
        cameOnline: Bool = true,
        registeredAt: Int64 = 0
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
    }

    /// Classify a registered/pending pod. `online` short-circuits on
    /// `cameOnline`. Otherwise a live unlock request wins (waitingForApproval);
    /// failing that, a recent registration is `comingOnline` and an old one is
    /// `dead`. Pending (pre-registration) pods are reported `comingOnline` so
    /// they never read as dead — the list keeps its own Pending pill for them.
    public func livenessState(
        hasLiveUnlockRequest: Bool,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> LivenessState {
        if status == .online && cameOnline { return .online }
        if hasLiveUnlockRequest { return .waitingForApproval }
        if status == .pending { return .comingOnline }
        let age = now - registeredAt
        if registeredAt > 0 && age <= PodInfo.comingOnlineGraceMs { return .comingOnline }
        return .dead
    }
}
