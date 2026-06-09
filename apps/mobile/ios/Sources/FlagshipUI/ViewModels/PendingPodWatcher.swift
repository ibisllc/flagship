import Foundation
import Observation
import FlagshipAPI
import FlagshipCore

/// Polls flagshipserver.com `GET /api/order/<serial>/status` (the single
/// canonical provisioning channel) for each pending pod and:
///
///   - Fires `InstallProgressBridge.onStep(phase:)` for each newly-seen
///     `ProvisionStatusPhase` so the Live Activity card advances on the
///     Lock Screen / Dynamic Island.
///   - On the terminal `.live` phase, flips the pod's status from
///     `.pending` to `.online` in AppState (using the canonical
///     `serverDomain`). The Home tab's pod card and the Pod Status Widget
///     then reflect the new state on their next render.
///   - On `.error`, leaves the pod pending and fires
///     `InstallProgressBridge.onFailed` so the Live Activity ends with the
///     failure card (the user can tap Cancel Order from the pending pod's
///     detail page).
///
/// One watcher per pending pod. Lifetime: from .pending → terminal phase
/// or pod removal. Polling cadence: 5s while pending, with a soft cap of
/// 1 hour so an abandoned install eventually stops burning battery.
@MainActor
@Observable
public final class PendingPodWatcher {
    // `nonisolated` so the init default-argument expression (evaluated in a
    // nonisolated context) can read them under the Swift 6 language mode — safe
    // because they're immutable Sendable constants, not main-actor state.
    // Mirrors ProvisionTimelineViewModel.
    public nonisolated static let pollInterval: UInt64 = 5_000_000_000   // 5s
    public nonisolated static let watchTimeout: UInt64  = 60 * 60_000_000_000  // 1h

    /// After this many CONSECUTIVE no-checkpoint (404 → nil) polls, the
    /// watcher consults `isSerialStillOutstanding` to decide whether the
    /// serial is a real-but-quiet order (keep waiting) or a dead one
    /// (unknown/expired/wiped/cancelled → drop, don't spin forever). The
    /// threshold gives a freshly-minted order that hasn't checkpointed yet
    /// a few ticks of grace before we challenge it.
    public nonisolated static let staleProbeAfterMissedPolls = 3

    private let serial: String
    private let podId: String
    private let app: AppState
    private let server: any FlagshipServerClient
    /// Nanoseconds between polls. Defaults to 5s in production; tests
    /// inject a tiny value to drive a multi-step progression fast.
    private let pollIntervalNanos: UInt64
    /// Index into `ProvisionStatusPhase.ordered` of the furthest phase
    /// whose `onStep` we've already fired — so we don't re-fire a phase
    /// the canonical channel keeps reporting on every poll.
    private var firedThroughIndex: Int = -1
    private var task: Task<Void, Never>?
    /// Count of consecutive polls that found NO checkpoint (the canonical
    /// channel 404'd → nil). Reset to 0 the moment any status arrives.
    private var consecutiveNoCheckpoint: Int = 0
    /// #43 — authority for "is this serial still a REAL order?" Returns
    /// true (still outstanding → keep waiting), false (definitively gone →
    /// the pod is a ghost; drop it + stop), or nil (couldn't tell — a
    /// network blip; keep waiting, the canonical channel is still the
    /// no-checkpoint-yet fallback). Backed by the outstanding-orders
    /// endpoint via the reconciler. Absent ⇒ legacy behaviour (a 404
    /// always means "try again"), so existing call-sites are unaffected.
    private let isSerialStillOutstanding: (@MainActor () async -> Bool?)?

    public init(
        serial: String,
        podId: String,
        app: AppState,
        server: any FlagshipServerClient,
        pollIntervalNanos: UInt64 = PendingPodWatcher.pollInterval,
        isSerialStillOutstanding: (@MainActor () async -> Bool?)? = nil
    ) {
        self.serial = serial
        self.podId = podId
        self.app = app
        self.server = server
        self.pollIntervalNanos = pollIntervalNanos
        self.isSerialStillOutstanding = isSerialStillOutstanding
    }

    public func start() {
        stop()
        let startedAt = DispatchTime.now().uptimeNanoseconds
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if DispatchTime.now().uptimeNanoseconds - startedAt > Self.watchTimeout {
                    return
                }
                if !self.podStillPending() { return }
                let terminal = await self.pollOnce()
                if terminal { return }
                try? await Task.sleep(nanoseconds: self.pollIntervalNanos)
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    private func podStillPending() -> Bool {
        guard let pod = app.pods.first(where: { $0.podId == podId }) else { return false }
        return pod.status == .pending
    }

    /// One poll round-trip. Returns true if a terminal phase was observed
    /// (so the outer loop can return without sleeping).
    private func pollOnce() async -> Bool {
        // The single canonical channel. nil on a 404 (no checkpoint yet)
        // or a network blip. Historically we treated this as "try again
        // next tick" forever — which is exactly why a wiped/expired serial
        // spun at "booting" indefinitely (#43). We still keep waiting while
        // the order is plausibly mid-install, but after a few consecutive
        // no-checkpoint polls we challenge the serial against the
        // outstanding-orders authority: if it's definitively gone, the pod
        // is a ghost — drop it and stop.
        guard let status = (try? await server.fetchProvisionStatus(serial: serial)) ?? nil else {
            consecutiveNoCheckpoint += 1
            if consecutiveNoCheckpoint >= Self.staleProbeAfterMissedPolls,
               let authority = isSerialStillOutstanding {
                // Only a DEFINITIVE "no, this is not a real order" drops the
                // pod. true (still outstanding) and nil (couldn't tell —
                // network blip) both keep waiting: no-checkpoint-yet is a
                // state, not a failure.
                if await authority() == false {
                    dropGhostPod()
                    return true
                }
            }
            return false
        }
        consecutiveNoCheckpoint = 0

        // Fire onStep for each newly-reached non-terminal ladder phase so
        // the Live Activity advances monotonically.
        if let idx = ProvisionStatusPhase.ordered.firstIndex(of: status.phase) {
            while firedThroughIndex < idx {
                firedThroughIndex += 1
                let phase = ProvisionStatusPhase.ordered[firedThroughIndex]
                if phase != .live {
                    InstallProgressBridge.shared.onStep?(phase)
                }
            }
        }

        switch status.phase {
        case .live:
            let fqdn = (status.serverDomain?.isEmpty ?? true) ? nil : status.serverDomain
            flipPodToOnline(fqdn: fqdn)
            InstallProgressBridge.shared.onComplete?(fqdn ?? "")
            return true
        case .error:
            InstallProgressBridge.shared.onFailed?(status.detail ?? "Setup hit a problem")
            return true
        default:
            return false
        }
    }

    /// #43 — the serial is no longer a real order (the outstanding-orders
    /// authority said so), so this pending pod is a ghost. Remove it from
    /// AppState + the local pending store so it stops spinning at "booting".
    private func dropGhostPod() {
        app.removePod(podId)
        if let user = app.currentUser, !user.isEmpty {
            PendingServerStore().remove(username: user, podId: podId)
        }
    }

    /// Replace the pod's PodInfo with an .online copy. Preserves podId,
    /// name, description, leader-ness, current-pod-ness so the user's
    /// selection state is undisturbed.
    private func flipPodToOnline(fqdn: String?) {
        guard let idx = app.pods.firstIndex(where: { $0.podId == podId }) else { return }
        let old = app.pods[idx]
        let next = PodInfo(
            podId: old.podId,
            name: old.name,
            description: old.description,
            fqdn: fqdn ?? old.fqdn,
            status: .online,
            pendingAuthCodeSerial: nil    // serial no longer relevant once online
        )
        app.pods[idx] = next
        // It's a real (registered) server now — drop the local pending record
        // so it isn't re-added as pending on the next launch.
        if let user = app.currentUser, !user.isEmpty {
            PendingServerStore().remove(username: user, podId: old.podId)
        }
    }
}

/// Coordinates one PendingPodWatcher per pending pod. View layer
/// (RootShell) re-runs `sync` on every AppState change; the registry
/// starts watchers for newly-pending pods and stops them for
/// transitions out (online / removed / signed out).
@MainActor
public final class PendingPodWatcherRegistry {
    private var watchers: [String: PendingPodWatcher] = [:]
    private let app: AppState
    private let server: any FlagshipServerClient

    public init(app: AppState, server: any FlagshipServerClient) {
        self.app = app
        self.server = server
    }

    public func sync() {
        let pendingPods = app.pods.filter { $0.status == .pending }
        let pendingIds = Set(pendingPods.map(\.podId))

        // Stop watchers whose pod is no longer pending.
        for (id, w) in watchers where !pendingIds.contains(id) {
            w.stop()
            watchers.removeValue(forKey: id)
        }
        // Start watchers for newly-pending pods that have a serial.
        for pod in pendingPods {
            guard watchers[pod.podId] == nil,
                  let serial = pod.pendingAuthCodeSerial,
                  !serial.isEmpty
            else { continue }
            let app = self.app
            let w = PendingPodWatcher(
                serial: serial,
                podId: pod.podId,
                app: app,
                server: server,
                isSerialStillOutstanding: { @MainActor [serial] in
                    // Non-biometric authority: the reconciler caches the
                    // signed outstanding-orders result here. Nil (never
                    // reconciled this session) ⇒ keep waiting; otherwise
                    // membership decides real-order vs. ghost.
                    guard let known = app.lastKnownOutstandingSerials else { return nil }
                    return known.contains(serial)
                }
            )
            watchers[pod.podId] = w
            w.start()
        }
    }

    public func stopAll() {
        for w in watchers.values { w.stop() }
        watchers.removeAll()
    }
}
