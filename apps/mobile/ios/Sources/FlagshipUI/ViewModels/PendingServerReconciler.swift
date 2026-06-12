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
/// HARDENING — the unauthenticated `pending[]` carries an opaque `orderRef`
/// (`hex(sha256("flagship/order-ref/v1|" + serial))`), NEVER the raw
/// auth-code serial: the serial is a write capability for fake provision
/// phases. A pod created on THIS device keeps its raw serial locally (for
/// the deep-progress poll + cancel revoke) and reconciles by hashing it;
/// a pod surfaced from the directory on another device reconciles by fqdn
/// and carries no serial.
///
/// Rules, applied in one pass over the single fetch:
///   - Upsert every registered entry as `.online` (identity unified on the
///     normalized fqdn, so a pending pod for the same box flips online in
///     place — no stuck-pending duplicate).
///   - Surface every pending order that has no local pod yet (by orderRef or
///     fqdn) as a `.pending` pod.
///   - Drop any LOCAL pending record whose fqdn/orderRef is in NEITHER array
///     (age-out dead orders — the home1 ghost).
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
        let registeredEntries = directory.pods.filter { $0.revokedAt == nil }
        for entry in registeredEntries where !entry.serverDomain.isEmpty {
            let fqdn = entry.serverDomain
            let pendingName = app.pods.first(where: {
                $0.fqdn.lowercased() == fqdn.lowercased() && $0.status == .pending
            })?.name
            // `cameOnline` — the box has reported daemon status or holds a
            // cert. A registered box with neither is "registered but never
            // came online"; the UI marks it + offers the decommission/free-
            // the-name delete instead of the lost/stolen revoke.
            app.upsertRegisteredPod(
                fqdn: fqdn,
                name: pendingName ?? Self.serverNameFromFqdn(fqdn),
                cameOnline: entry.cameOnline,
                registeredAt: entry.registeredAt ?? 0,
                awaitingUnlock: entry.awaitingUnlock
            )
        }

        // The registered servers are the non-pending pods now (including the
        // ones we just flipped online).
        let liveFqdns = Set(app.pods.filter { $0.status != .pending }.map { $0.fqdn })
        // The unauthenticated directory carries OPAQUE order refs
        // (sha256 of the canonical-tagged serial), never the raw serial —
        // the serial is a provision-status write capability. A pod this
        // device created holds the raw serial locally; we hash it to test
        // membership. A pod surfaced from the directory on a non-creating
        // device matches by fqdn instead.
        let outstandingRefs = Set(directory.pending.map(\.orderRef))
        let outstandingFqdns = Set(directory.pending.map { $0.fqdn.lowercased() })

        // Publish the authoritative ref set so the PendingPodWatcher can
        // tell "unknown serial" (drop) from "no checkpoint yet" (keep waiting)
        // WITHOUT a biometric prompt.
        app.lastKnownOutstandingOrderRefs = outstandingRefs

        // Drop any pending record whose box has since registered.
        store.reconcile(username: username, liveFqdns: liveFqdns)

        // Drop ghosts: local pending records whose order is in neither array.
        let droppedPodIds = store.dropGhosts(
            username: username,
            outstandingOrderRefs: outstandingRefs,
            outstandingFqdns: outstandingFqdns,
            liveFqdns: liveFqdns
        )
        for podId in droppedPodIds {
            app.removePod(podId)
        }
        // An in-memory-only pending pod (never persisted) whose order is dead
        // is dropped too. Pods with a locally-stored serial match by hashed
        // ref; serial-less pods (surfaced from the directory) match by fqdn.
        for pod in app.pods where pod.status == .pending {
            let stillOutstanding: Bool
            if let serial = pod.pendingAuthCodeSerial, !serial.isEmpty {
                stillOutstanding = outstandingRefs.contains(OrderRef.compute(serial: serial))
            } else {
                stillOutstanding = outstandingFqdns.contains(pod.fqdn.lowercased())
            }
            if !stillOutstanding && !liveFqdns.contains(pod.fqdn) {
                app.removePod(pod.podId)
            }
        }

        // Surface every outstanding order that has no pod yet. The new pod
        // carries NO auth-code serial (this device didn't mint the order, so
        // it has no right to the deep-progress/cancel-revoke capability) —
        // it shows list-level state and flips online via the next reconcile.
        let knownRefs = Set(
            app.pods
                .compactMap { $0.pendingAuthCodeSerial }
                .filter { !$0.isEmpty }
                .map { OrderRef.compute(serial: $0) }
        )
        let knownFqdns = Set(app.pods.map { $0.fqdn.lowercased() })
        for order in directory.pending {
            if !order.orderRef.isEmpty && knownRefs.contains(order.orderRef) { continue }
            if !order.fqdn.isEmpty && knownFqdns.contains(order.fqdn.lowercased()) { continue }
            // Identity unified on the fqdn so this pending pod and a later
            // registered `/pods` pod for the same box key on ONE id. A
            // ref-keyed fallback only for the degenerate empty-fqdn order.
            let podId = order.fqdn.isEmpty
                ? "pod-\(order.orderRef.prefix(10).lowercased())"
                : PodInfo.podId(forFqdn: order.fqdn)
            app.addPod(PodInfo(
                podId: podId,
                name: order.serverName,
                description: nil,
                fqdn: order.fqdn,
                status: .pending,
                pendingAuthCodeSerial: nil
            ))
            store.add(username: username, .init(
                podId: podId,
                name: order.serverName,
                description: "",
                fqdn: order.fqdn,
                authCodeSerial: "",
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
