import Foundation
import FlagshipAPI
import FlagshipCore

/// #43 — reconcile the phone's pod list against SERVER TRUTH.
///
/// The phone reconstructs "pending servers" from a local UserDefaults cache
/// (PendingServerStore). That cache drifts from what `.com` actually knows:
///
///   (a) an order minted server-side whose in-app `onDelivered` callback
///       never fired is INVISIBLE on the phone — the box installs +
///       registers but the app never shows it (the live "home2" bug);
///   (b) a stale local record whose order was wiped / expired / cancelled
///       lingers as a pending pod that spins forever at "booting" (the live
///       "home1" ghost);
///   (c) the watcher can't tell "unknown serial" from "no checkpoint yet".
///
/// This reconciler resolves all three by treating TWO server sources as
/// authoritative and merging them with the local cache:
///
///   - the registered `/pods` inventory (already in `app.pods` as non-pending
///     pods) — a server that has phoned home, and
///   - the new IRK-signed outstanding-orders endpoint — every in-flight order
///     the box could still legitimately register against.
///
/// Rules, applied in one pass:
///   d. Bind the local cache to the account IRK first — a reused username
///      under a different identity starts clean (no inherited ghosts).
///   b/c. Drop every local pending record whose serial is in NEITHER the
///      outstanding list NOR the registered set (age-out dead serials).
///   a. Surface every outstanding order that has no local pod yet (by serial
///      or fqdn) as a pending pod.
///
/// The signed fetch needs the account IRK (a biometric-gated key), so the
/// caller injects the signer; this keeps the reconciler unit-testable
/// without the Secure Enclave and lets callers gate WHEN the biometric
/// prompt fires (account setup + explicit refresh, never silently).
@MainActor
public struct PendingServerReconciler {
    /// Produces the IRK signature over the outstanding-orders canonical
    /// bytes PLUS the account IRK pub hex (used to key the local cache).
    public typealias Signer = @MainActor (_ username: String, _ issuedAt: Int64) async throws -> (signatureHex: String, irkPubHex: String)

    /// Fetches the REGISTERED `/pods` inventory as a set of normalized
    /// (lowercased) fqdns — the boxes that have phoned home and registered
    /// on `.com`. This is the AUTHORITATIVE "online" signal: a server here is
    /// live regardless of any heartbeat / cert side-channel (those aren't
    /// populated for a content-blind `.com` or a just-live box, which is
    /// exactly why a live server was stranded as Pending). A throw / nil ⇒
    /// couldn't reach the directory this pass; we leave existing state as-is.
    /// Defaults to an empty set so call-sites that don't wire the directory
    /// keep their prior behaviour.
    public typealias RegisteredFqdnsFetcher = @MainActor (_ username: String) async -> Set<String>?

    private let app: AppState
    private let server: any FlagshipServerClient
    private let store: PendingServerStore
    private let sign: Signer
    private let fetchRegisteredFqdns: RegisteredFqdnsFetcher
    private let now: () -> Int64

    public init(
        app: AppState,
        server: any FlagshipServerClient,
        store: PendingServerStore = PendingServerStore(),
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        fetchRegisteredFqdns: @escaping RegisteredFqdnsFetcher = { _ in [] },
        sign: @escaping Signer
    ) {
        self.app = app
        self.server = server
        self.store = store
        self.now = now
        self.fetchRegisteredFqdns = fetchRegisteredFqdns
        self.sign = sign
    }

    /// Run the full reconcile. Best-effort: a network/sign failure leaves the
    /// existing local state untouched (the cheap appearance-time
    /// `restorePendingServers` still keeps the UI sane). Returns silently on
    /// no signed-in user.
    public func reconcile() async {
        guard let username = app.currentUser, !username.isEmpty else { return }
        let issuedAt = now()
        let response: OutstandingOrdersResponse
        let irkPubHex: String
        do {
            let signed = try await sign(username, issuedAt)
            irkPubHex = signed.irkPubHex
            response = try await server.listOutstandingOrders(
                .init(
                    request: .init(username: username, issuedAt: issuedAt),
                    signature: signed.signatureHex
                )
            )
        } catch {
            // Couldn't reach / authorise the authority this pass — don't
            // mutate local state on a blip.
            return
        }

        // (d) Bind the cache to this identity (wipes a foreign-account
        // remnant under the same username).
        store.bindToAccount(username: username, accountKey: irkPubHex)

        // Registration is AUTHORITATIVE for online. Pull the registered
        // `/pods` inventory and surface every entry as an `.online` pod —
        // REGARDLESS of lastReported/cert (the channel `.com` returns null
        // for a content-blind / just-live box). A registered fqdn that
        // matches an existing pending pod flips that pod online in place
        // (identity is unified on the fqdn, so no stuck-pending duplicate);
        // a registered fqdn with no local pod is added fresh. A nil fetch
        // (couldn't reach the directory) just skips this step — we still
        // reconcile the outstanding-orders view below.
        if let registered = await fetchRegisteredFqdns(username) {
            for fqdn in registered where !fqdn.isEmpty {
                // Prefer the pending record's display name (the user typed
                // it at create time) if we have one for this fqdn.
                let pendingName = app.pods.first(where: {
                    $0.fqdn.lowercased() == fqdn.lowercased() && $0.status == .pending
                })?.name
                app.upsertRegisteredPod(
                    fqdn: fqdn,
                    name: pendingName ?? Self.serverNameFromFqdn(fqdn)
                )
            }
        }

        // Registered servers (the /pods inventory) are the non-pending pods
        // now — including the ones we just flipped online above.
        let liveFqdns = Set(app.pods.filter { $0.status != .pending }.map { $0.fqdn })
        let outstandingSerials = Set(response.orders.map(\.serial))

        // Publish the authoritative serial set so the PendingPodWatcher can
        // tell "unknown serial" (drop) from "no checkpoint yet" (keep
        // waiting) WITHOUT re-triggering the biometric IRK derive.
        app.lastKnownOutstandingSerials = outstandingSerials

        // Drop any pending record whose box has since registered.
        store.reconcile(username: username, liveFqdns: liveFqdns)

        // (b/c) Drop ghosts: local pending records whose serial is in neither
        // server source. Also remove their pods from AppState in the same pass.
        let droppedPodIds = store.dropGhosts(
            username: username,
            outstandingSerials: outstandingSerials,
            liveFqdns: liveFqdns
        )
        for podId in droppedPodIds {
            app.removePod(podId)
        }
        // A pending pod whose serial is dead but that was never persisted to
        // the store (e.g. an in-memory-only ghost) is dropped too.
        for pod in app.pods where pod.status == .pending {
            guard let serial = pod.pendingAuthCodeSerial, !serial.isEmpty else { continue }
            if !outstandingSerials.contains(serial) && !liveFqdns.contains(pod.fqdn) {
                app.removePod(pod.podId)
            }
        }

        // (a) Surface every outstanding order that has no pod yet.
        let knownSerials = Set(
            app.pods.compactMap { $0.pendingAuthCodeSerial }
        )
        let knownFqdns = Set(app.pods.map { $0.fqdn.lowercased() })
        for order in response.orders {
            if knownSerials.contains(order.serial) { continue }
            if knownFqdns.contains(order.fqdn.lowercased()) { continue }
            // Identity unified on the fqdn so this pending pod, a later
            // registered `/pods` pod for the same box, and the store record
            // all key on ONE id (no stuck-pending duplicate when it goes
            // live). A serial-keyed fallback only for the degenerate empty-
            // fqdn order (no predicted domain yet).
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
            store.add(username: username, accountKey: irkPubHex, .init(
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
