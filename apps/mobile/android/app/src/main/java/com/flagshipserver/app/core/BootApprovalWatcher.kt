// Account-level "which of my boxes are waiting for a boot-unlock approval
// right now?" — ONE poll that fans the answer out to every server card,
// detail page, and the post-creation checklist via
// AppState.serversAwaitingApproval. Kotlin mirror of iOS BootApprovalWatcher.
//
// The complement to the per-server approval flow (SecretRequestsScreen):
// rather than poll one coordinator per row, this reuses the SAME
// SecretRequestCoordinator.fetchVerifiedRequests() account-wide fetch once,
// maps the verified, non-expired unlock-key requests to their serverDomains,
// and publishes the set. A pod is WAITING_FOR_APPROVAL iff its fqdn is in it.
//
// Best-effort: a fetch failure leaves the prior set untouched (no thrash on a
// blip). No biometric beyond the IRK-signed mailbox-auth *read* the coordinator
// already does — Face ID stays only on the Approve mutation.

package com.flagshipserver.app.core

class BootApprovalWatcher(
    private val app: AppState,
    private val makeCoordinator: () -> SecretRequestCoordinator?,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    /** One account-wide fetch → publish the set of fqdns with a LIVE
     *  (non-expired) unlock-key request onto AppState. Best-effort: a throw
     *  leaves the set untouched. Returns the resolved set. */
    suspend fun pollOnce(): Set<String> {
        val coord = makeCoordinator() ?: return app.serversAwaitingApproval.value
        val verified = runCatching { coord.fetchVerifiedRequests() }
            .getOrElse { return app.serversAwaitingApproval.value }
        val t = now()
        val waiting = verified
            .filter { it.purpose == SecretPurpose.UNLOCK_KEY && t <= it.pending.expiresAt }
            .map { it.serverDomain.lowercase() }
            .toSet()
        app.setServersAwaitingApproval(waiting)
        return waiting
    }
}
