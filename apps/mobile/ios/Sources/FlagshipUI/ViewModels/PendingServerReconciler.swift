import Foundation
import FlagshipAPI
import FlagshipCore

/// #43 + #56 — reconcile the phone's pod list against SERVER TRUTH.
///
/// The phone reconstructs "pending servers" from a local UserDefaults cache
/// (PendingServerStore). That cache drifts from what `.com` actually knows:
///
///   (a) an order minted server-side whose in-app `onDelivered` callback
///       never fired is INVISIBLE on the phone — the box installs +
///       registers but the app never shows it (the live "home2" bug);
///   (b) a stale local record whose order was wiped / expired / cancelled
///       lingers as a pending pod that spins forever at "booting" (the live
///       "home1" ghost).
///
/// #56 — CONSOLIDATION. The server list used to ride TWO endpoints with
/// different auth: registered servers via the UNAUTHENTICATED `/pods`, and
/// in-flight orders via the biometric-IRK-signed `outstanding-orders`. A
/// just-created, not-yet-registered server rode ONLY the fragile biometric
/// path; when its per-order `provision_status` lookup silently failed, the old
/// reconciler swallowed the whole fetch (`catch { return }`) — the server went
/// invisible AND the user ate a pointless Face ID prompt. The biometric
/// protected nothing (the endpoint 404s on an unknown username BEFORE checking
/// the signature, and `/pods` is unauthenticated anyway).
///
/// Now there is ONE unauthenticated source: the merged `/pods` response
/// carries `pods` (registered, tagged online) AND `pending` (active orders,
/// tagged pending). A list refresh triggers NO biometric prompt. Biometric
/// stays ONLY on mutations (create-server / release / revoke), never on a read.
///
/// Rules, applied in one pass over the single fetch:
///   - Upsert every registered entry as `.online` (identity unified on the
///     normalized fqdn, so a pending pod for the same box flips online in
///     place — no stuck-pending duplicate).
///   - Surface every pending order that has no local pod yet (by serial or
///     fqdn) as a `.pending` pod.
///   - Drop any LOCAL pending record whose fqdn/serial is in NEITHER array
///     (age-out dead serials — the home1 ghost).
@MainActor
public struct PendingServerReconciler {
    /// Fetches the merged `/pods` directory (registered + pending) for the
    /// account. UNAUTHENTICATED — no signer, no biometric. A throw / nil ⇒
    /// couldn't reach the directory this pass; leave existing state as-is.
    public typealias PodsFetcher = @MainActor (_ username: String) async -> PodsDirectoryResponse?

    private let app: AppState
    private let store: PendingServerStore
    private let fetchPods: PodsFetcher
    private let now: () -> Int64

    public init(
        app: AppState,
        store: PendingServerStore = PendingServerStore(),
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        fetchPods: @escaping PodsFetcher
    ) {
        self.app = app
        self.store = store
        self.now = now
        self.fetchPods = fetchPods
    }

    /// Run the full reconcile from the single merged `/pods` fetch. Best-effort:
    /// a network failure leaves the existing local state untouched (the cheap
    /// appearance-time `restorePendingServers` still keeps the UI sane). NO
    /// biometric prompt — this is a pure read. Returns silently on no signed-in
    /// user or an unreachable directory.
    public func reconcile() async {
        guard let username = app.currentUser, !username.isEmpty else { return }

        // ONE unauthenticated fetch — registered servers AND active orders.
        // A nil (couldn't reach the directory) leaves all state untouched.
        guard let directory = await fetchPods(username) else { return }

        // Surface every registered server as `.online` — REGARDLESS of
        // lastReported/cert (the channel `.com` returns null for a
        // content-blind / just-live box). A registered fqdn matching a pending
        // pod flips it online in place (identity unified on the fqdn); a new
        // fqdn is added fresh.
        let registeredFqdns = directory.pods
            .filter { $0.revokedAt == nil }
            .map { $0.serverDomain }
        for fqdn in registeredFqdns where !fqdn.isEmpty {
            let pendingName = app.pods.first(where: {
                $0.fqdn.lowercased() == fqdn.lowercased() && $0.status == .pending
            })?.name
            app.upsertRegisteredPod(
                fqdn: fqdn,
                name: pendingName ?? Self.serverNameFromFqdn(fqdn)
            )
        }

        // The registered servers are the non-pending pods now (including the
        // ones we just flipped online).
        let liveFqdns = Set(app.pods.filter { $0.status != .pending }.map { $0.fqdn })
        let outstandingSerials = Set(directory.pending.map(\.serial))

        // Publish the authoritative serial set so the PendingPodWatcher can
        // tell "unknown serial" (drop) from "no checkpoint yet" (keep waiting)
        // WITHOUT a biometric prompt.
        app.lastKnownOutstandingSerials = outstandingSerials

        // Drop any pending record whose box has since registered.
        store.reconcile(username: username, liveFqdns: liveFqdns)

        // Drop ghosts: local pending records whose serial is in neither array.
        let droppedPodIds = store.dropGhosts(
            username: username,
            outstandingSerials: outstandingSerials,
            liveFqdns: liveFqdns
        )
        for podId in droppedPodIds {
            app.removePod(podId)
        }
        // An in-memory-only pending pod (never persisted) whose serial is dead
        // is dropped too.
        for pod in app.pods where pod.status == .pending {
            guard let serial = pod.pendingAuthCodeSerial, !serial.isEmpty else { continue }
            if !outstandingSerials.contains(serial) && !liveFqdns.contains(pod.fqdn) {
                app.removePod(pod.podId)
            }
        }

        // Surface every outstanding order that has no pod yet.
        let knownSerials = Set(app.pods.compactMap { $0.pendingAuthCodeSerial })
        let knownFqdns = Set(app.pods.map { $0.fqdn.lowercased() })
        for order in directory.pending {
            if knownSerials.contains(order.serial) { continue }
            if knownFqdns.contains(order.fqdn.lowercased()) { continue }
            // Identity unified on the fqdn so this pending pod and a later
            // registered `/pods` pod for the same box key on ONE id. A
            // serial-keyed fallback only for the degenerate empty-fqdn order.
            let podId = order.fqdn.isEmpty
                ? "pod-\(order.serial.prefix(10).lowercased())"
                : PodInfo.podId(forFqdn: order.fqdn)
            app.addPod(PodInfo(
                podId: podId,
                name: order.serverName,
                description: nil,
                fqdn: order.fqdn,
                status: .pending,
                pendingAuthCodeSerial: order.serial
            ))
            store.add(username: username, .init(
                podId: podId,
                name: order.serverName,
                description: "",
                fqdn: order.fqdn,
                authCodeSerial: order.serial,
                createdAt: Double(order.createdAt) / 1000.0
            ))
        }
    }

    /// Best-effort display name from a `<server>.<user>.flagship.services`
    /// fqdn — the leftmost label, used only when we have no pending record
    /// (which carries the user's typed name) for a registered server we're
    /// surfacing for the first time.
    static func serverNameFromFqdn(_ fqdn: String) -> String {
        let label = fqdn.split(separator: ".").first.map(String.init) ?? fqdn
        return label.isEmpty ? fqdn : label
    }
}
