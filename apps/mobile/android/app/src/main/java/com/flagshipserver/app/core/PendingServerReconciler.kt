// #56 — reconcile the phone's server list against SERVER TRUTH from ONE
// unauthenticated `/pods` fetch. Kotlin mirror of the iOS
// FlagshipUI/ViewModels/PendingServerReconciler.swift.
//
// Android historically built its server list purely imperatively: a pod was
// appended (as ONLINE) only when the in-app install-progress flow finished on
// THIS device. An order minted server-side whose in-app callback never fired
// (the box installs + registers but the app never shows it — the "home2" bug)
// was invisible; a stale pending pod whose order was wiped/expired/cancelled
// lingered forever (the "home1" ghost). The iOS pending-reconciliation work
// was never ported — so Android never surfaced in-flight orders at all.
//
// The merged `/pods` response now carries BOTH `pods` (registered, online) and
// `pending` (active orders). This reconciler folds the single fetch into
// AppState in one pass:
//   - Upsert every registered entry as ONLINE (identity unified on the
//     normalized fqdn, so a pending pod for the same box flips online in place
//     — no stuck-pending duplicate, registered SUPERSEDES pending).
//   - Surface every pending order that has no local pod yet (by orderRef or
//     fqdn) as a PENDING pod, carrying its phase.
//   - Drop any LOCAL pending pod whose orderRef/fqdn is in NEITHER array
//     (age-out dead orders — the home1 ghost).
//
// HARDENING — the unauthenticated `pending[]` carries an opaque `orderRef`
// (`hex(sha256("flagship/order-ref/v1|" + serial))`, see core.OrderRef),
// NEVER the raw auth-code serial: the serial is a write capability for fake
// provision phases. A pod created on THIS device keeps its raw serial
// locally (deep-progress poll + cancel revoke) and reconciles by hashing it;
// a pod surfaced from the directory on another device reconciles by fqdn and
// carries no serial.
//
// The fetch is UNAUTHENTICATED (no IRK signer, no biometric). A list refresh
// therefore triggers NO biometric prompt; biometric stays ONLY on mutations
// (create-server / release / revoke).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.PodsDirectoryResponse
import com.flagshipserver.app.api.SecretMailboxClient

class PendingServerReconciler(
    private val app: AppState,
    private val mailbox: SecretMailboxClient,
) {
    /** Run the full reconcile from the single merged `/pods` fetch.
     *  Best-effort: a network failure (or no signed-in user) leaves the
     *  existing local state untouched. NO biometric prompt — a pure read. */
    suspend fun reconcile() {
        val username = app.currentUser.value
        if (username.isNullOrEmpty()) return

        // ONE unauthenticated fetch — registered servers AND active orders.
        // A throw (couldn't reach the directory) leaves all state untouched.
        val directory: PodsDirectoryResponse =
            runCatching { mailbox.fetchPods(username) }.getOrNull() ?: return

        // Surface every registered server as ONLINE — REGARDLESS of any
        // heartbeat/cert side-channel. A registered fqdn matching a pending pod
        // flips it online in place (identity unified on the fqdn); a new fqdn
        // is added fresh. Registered SUPERSEDES pending.
        val registeredEntries = directory.pods
            .filter { it.revokedAt == null && it.serverDomain.isNotEmpty() }
        for (entry in registeredEntries) {
            val fqdn = entry.serverDomain
            val pendingName = app.pods.value.firstOrNull {
                it.fqdn.lowercase() == fqdn.lowercase() && it.status == PodInfo.Status.PENDING
            }?.name
            // `cameOnline` — a registered box with no daemon check-in + no cert
            // is "registered but never came online"; the UI marks it + offers
            // the decommission/free-the-name delete instead of the revoke.
            app.upsertRegisteredPod(
                fqdn = fqdn,
                name = pendingName ?: serverNameFromFqdn(fqdn),
                cameOnline = entry.cameOnline,
            )
        }

        // The non-pending pods are the live ones now (including the ones we
        // just flipped online).
        val liveFqdns = app.pods.value
            .filter { it.status != PodInfo.Status.PENDING }
            .map { it.fqdn.lowercase() }
            .toSet()
        // The directory carries OPAQUE order refs (sha256 of the canonical-
        // tagged serial), never the raw serial — the serial is a provision-
        // status write capability. Pods this device created hold the raw
        // serial locally; we hash it to test membership. Directory-surfaced
        // (serial-less) pods match by fqdn instead.
        val outstandingRefs = directory.pending.map { it.orderRef }.toSet()
        val outstandingFqdns = directory.pending.map { it.fqdn.lowercase() }.toSet()

        // Drop ghosts: local pending pods whose box has since registered, OR
        // whose orderRef/fqdn is in NEITHER array (a dead order).
        for (pod in app.pods.value) {
            if (pod.status != PodInfo.Status.PENDING) continue
            val registered = liveFqdns.contains(pod.fqdn.lowercase())
            val serial = pod.pendingAuthCodeSerial
            val stillOutstanding = if (serial != null) {
                outstandingRefs.contains(OrderRef.compute(serial))
            } else {
                outstandingFqdns.contains(pod.fqdn.lowercase())
            }
            if (registered || !stillOutstanding) {
                app.removePod(pod.podId)
            }
        }

        // Surface every outstanding order that has no pod yet (by orderRef or
        // fqdn). Identity unified on the fqdn so this pending pod and a later
        // registered `/pods` pod for the same box key on ONE id. The new pod
        // carries NO auth-code serial (this device didn't mint the order, so
        // it has no right to the deep-progress/cancel-revoke capability) — it
        // shows list-level state and flips online via the next reconcile.
        val knownRefs = app.pods.value
            .mapNotNull { it.pendingAuthCodeSerial }
            .map { OrderRef.compute(it) }
            .toSet()
        val knownFqdns = app.pods.value.map { it.fqdn.lowercase() }.toSet()
        for (order in directory.pending) {
            if (order.orderRef.isNotEmpty() && knownRefs.contains(order.orderRef)) continue
            if (order.fqdn.isNotEmpty() && knownFqdns.contains(order.fqdn.lowercase())) continue
            val podId = if (order.fqdn.isEmpty()) {
                "pod-" + order.orderRef.take(10).lowercase()
            } else {
                PodInfo.podId(order.fqdn)
            }
            app.addPod(
                PodInfo(
                    podId = podId,
                    name = order.serverName,
                    description = null,
                    fqdn = order.fqdn,
                    status = PodInfo.Status.PENDING,
                    pendingAuthCodeSerial = null,
                ),
            )
        }
    }

    /** Best-effort display name from a `<server>.<user>.flagship.services`
     *  fqdn — the leftmost label, used only when we have no pending record
     *  (which carries the user's typed name) for a registered server we're
     *  surfacing for the first time. */
    private fun serverNameFromFqdn(fqdn: String): String {
        val label = fqdn.substringBefore('.')
        return label.ifEmpty { fqdn }
    }
}
