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
//   - Surface every pending order that has no local pod yet (by serial or
//     fqdn) as a PENDING pod, carrying its phase.
//   - Drop any LOCAL pending pod whose serial/fqdn is in NEITHER array
//     (age-out dead serials — the home1 ghost).
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
        val registeredFqdns = directory.pods
            .filter { it.revokedAt == null }
            .map { it.serverDomain }
            .filter { it.isNotEmpty() }
        for (fqdn in registeredFqdns) {
            val pendingName = app.pods.value.firstOrNull {
                it.fqdn.lowercase() == fqdn.lowercase() && it.status == PodInfo.Status.PENDING
            }?.name
            app.upsertRegisteredPod(fqdn = fqdn, name = pendingName ?: serverNameFromFqdn(fqdn))
        }

        // The non-pending pods are the live ones now (including the ones we
        // just flipped online).
        val liveFqdns = app.pods.value
            .filter { it.status != PodInfo.Status.PENDING }
            .map { it.fqdn.lowercase() }
            .toSet()
        val outstandingSerials = directory.pending.map { it.serial }.toSet()

        // Drop ghosts: local pending pods whose box has since registered, OR
        // whose serial/fqdn is in NEITHER array (a dead order).
        for (pod in app.pods.value) {
            if (pod.status != PodInfo.Status.PENDING) continue
            val registered = liveFqdns.contains(pod.fqdn.lowercase())
            val serial = pod.pendingAuthCodeSerial
            val stillOutstanding = serial != null && outstandingSerials.contains(serial)
            if (registered || !stillOutstanding) {
                app.removePod(pod.podId)
            }
        }

        // Surface every outstanding order that has no pod yet (by serial or
        // fqdn). Identity unified on the fqdn so this pending pod and a later
        // registered `/pods` pod for the same box key on ONE id.
        val knownSerials = app.pods.value.mapNotNull { it.pendingAuthCodeSerial }.toSet()
        val knownFqdns = app.pods.value.map { it.fqdn.lowercase() }.toSet()
        for (order in directory.pending) {
            if (knownSerials.contains(order.serial)) continue
            if (order.fqdn.isNotEmpty() && knownFqdns.contains(order.fqdn.lowercase())) continue
            val podId = if (order.fqdn.isEmpty()) {
                "pod-" + order.serial.take(10).lowercase()
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
                    pendingAuthCodeSerial = order.serial,
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
