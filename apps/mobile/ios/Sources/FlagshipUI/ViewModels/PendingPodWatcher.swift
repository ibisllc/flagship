import Foundation
import Observation
import FlagshipAPI
import FlagshipCore

/// Polls flagshipserver.com `/api/install-events/<serial>` for each
/// pending pod and:
///
///   - Maps each new install-event into an
///     `InstallProgressViewModel.Step` and fires the
///     `InstallProgressBridge` callbacks so the Live Activity card
///     advances on the Lock Screen / Dynamic Island.
///   - On the terminal `ready` event, flips the pod's status
///     from `.pending` to `.online` in AppState. The Home tab's
///     pod card and the Pod Status Widget then reflect the new
///     state on their next render.
///   - On `failed`, leaves the pod pending and fires
///     `InstallProgressBridge.onFailed` so the Live Activity ends
///     with the failure card (user can tap Cancel Order from the
///     pending pod's detail page).
///
/// One watcher per pending pod. Lifetime: from .pending → terminal
/// event or pod removal. Polling cadence: 5s while pending, with a
/// soft cap of 1 hour so an abandoned install eventually stops
/// burning battery.
@MainActor
@Observable
public final class PendingPodWatcher {
    public static let pollInterval: UInt64 = 5_000_000_000   // 5s
    public static let watchTimeout: UInt64  = 60 * 60_000_000_000  // 1h

    private let serial: String
    private let podId: String
    private let app: AppState
    private let server: any FlagshipServerClient
    private var cursor: Int = 0
    private var task: Task<Void, Never>?

    public init(serial: String, podId: String, app: AppState, server: any FlagshipServerClient) {
        self.serial = serial
        self.podId = podId
        self.app = app
        self.server = server
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
                try? await Task.sleep(nanoseconds: Self.pollInterval)
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

    /// One poll round-trip. Returns true if a terminal event was
    /// observed (so the outer loop can return without sleeping).
    private func pollOnce() async -> Bool {
        let resp: InstallEventsPollResponse
        do {
            resp = try await server.getInstallEvents(serial: serial, since: cursor)
        } catch {
            // Treat network errors as "try again next tick" — don't
            // surface to the user (the install card already shows
            // "boot disk on the way"; a 5s blip isn't noteworthy).
            return false
        }
        cursor = resp.cursor
        for record in resp.events {
            if let step = Self.mapStep(record.eventName) {
                InstallProgressBridge.shared.onStep?(step)
            }
            if record.eventName == "ready" {
                let fqdn = record.detail.isEmpty ? nil : record.detail
                flipPodToOnline(fqdn: fqdn)
                InstallProgressBridge.shared.onComplete?(record.detail)
                return true
            }
            if record.eventName == "failed" {
                InstallProgressBridge.shared.onFailed?(record.detail)
                return true
            }
        }
        return false
    }

    /// Replace the pod's PodInfo with an .online copy. Preserves
    /// podId, name, description, leader-ness, current-pod-ness so
    /// the user's selection state is undisturbed.
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

    static func mapStep(_ eventName: String) -> InstallProgressViewModel.Step? {
        switch eventName {
        case "registered":   return .registered
        case "boot":         return .boot
        case "tunnel-online": return .tunnelOnline
        case "cert-issued":  return .certIssued
        case "ready":        return .ready
        default:             return nil
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
            let w = PendingPodWatcher(
                serial: serial,
                podId: pod.podId,
                app: app,
                server: server
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
