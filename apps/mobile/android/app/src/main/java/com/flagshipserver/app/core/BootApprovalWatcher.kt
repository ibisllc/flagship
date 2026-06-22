// Account-level "which of my boxes are waiting for a boot-unlock approval
// right now?" — ONE poll that fans the answer out to every server card,
// detail page, and the post-creation checklist via
// AppState.serversAwaitingApproval. Kotlin mirror of iOS BootApprovalWatcher.
//
// DIRECTORY-DRIVEN, NO BIOMETRIC. Detection reads the unauthenticated `/pods`
// directory's cheap `awaitingUnlock` flag — NOT the IRK-signed mailbox. The
// previous implementation polled SecretRequestCoordinator.fetchVerifiedRequests()
// every 5s, which derives the IRK (a Keystore biometric gate): on a real device
// that fired Face ID on the Home tab every freshness window. Face ID now fires
// ONLY on the actual Approve mutation, never to detect.
//
// Best-effort: the `pollAwaiting` closure swallows failures and returns the
// prior set, so a blip never thrashes the UI.

package com.flagshipserver.app.core

/** The two account-level "boxes waiting for an approval" sets the watcher
 *  publishes from ONE poll — the Box Request Inbox detection tier
 *  (docs/box-request-inbox.md). `unlock` feeds the boot-unlock card; `entitlement`
 *  feeds the serve-authorization card. Both are lowercased-fqdn sets off the
 *  cheap unauthenticated `/pods` digest (no biometric). Mirror of iOS. */
data class PendingApprovalSets(
    val unlock: Set<String> = emptySet(),
    val entitlement: Set<String> = emptySet(),
)

class BootApprovalWatcher(
    private val app: AppState,
    /** Refresh the `/pods` directory (unauthenticated, NO biometric) and return
     *  the fqdn sets it marks `awaitingUnlock` / `awaitingEntitlement`. */
    private val pollAwaiting: suspend () -> PendingApprovalSets,
) {
    /** One directory refresh → publish both pending-approval sets onto AppState
     *  (unlock + entitlement). Returns the resolved sets. */
    suspend fun pollOnce(): PendingApprovalSets {
        val sets = pollAwaiting()
        app.setServersAwaitingApproval(sets.unlock)
        app.setServersAwaitingEntitlement(sets.entitlement)
        return sets
    }
}
