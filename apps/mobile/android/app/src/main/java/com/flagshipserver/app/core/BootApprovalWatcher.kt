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

class BootApprovalWatcher(
    private val app: AppState,
    /** Refresh the `/pods` directory (unauthenticated, NO biometric) and return
     *  the set of server fqdns the directory marks `awaitingUnlock`. */
    private val pollAwaiting: suspend () -> Set<String>,
) {
    /** One directory refresh → publish the set of fqdns with a pending unlock
     *  request onto AppState. Returns the resolved set. */
    suspend fun pollOnce(): Set<String> {
        val waiting = pollAwaiting()
        app.setServersAwaitingApproval(waiting)
        return waiting
    }
}
