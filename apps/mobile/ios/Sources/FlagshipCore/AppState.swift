import Foundation
import Observation

/// App-wide observable state. The single source of truth for "who is the
/// user, which servers do they own, which one is the leader."
///
/// `isPaired` gates the RootShell — when false, the OnboardingFlow is
/// presented as a full-screen cover. The first pod added is automatically
/// marked leader; users can change which pod is leader later from the
/// pod card context menu.
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
        isUnlocked: Bool? = nil
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
    }

    public func addPod(_ pod: PodInfo) {
        pods.append(pod)
        if leaderPodId == nil { leaderPodId = pod.podId }
        if currentPodId == nil { currentPodId = pod.podId }
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
    /// For pods in `.pending` status, the auth-code serial issued at
    /// CreateServer time. Lets Cancel-order revoke the auth-code on
    /// flagshipserver.com instead of just removing the pod locally.
    public let pendingAuthCodeSerial: String?
    public var id: String { podId }

    public init(
        podId: String,
        name: String,
        description: String? = nil,
        fqdn: String,
        status: Status = .unknown,
        pendingAuthCodeSerial: String? = nil
    ) {
        self.podId = podId
        self.name = name
        self.description = description
        self.fqdn = fqdn
        self.status = status
        self.pendingAuthCodeSerial = pendingAuthCodeSerial
    }
}
