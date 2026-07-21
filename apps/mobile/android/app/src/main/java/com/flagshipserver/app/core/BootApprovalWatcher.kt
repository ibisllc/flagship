// Account-level "which of my boxes are waiting for an approval right now, and
// for WHAT?" — ONE poll that publishes the unified Box Request Inbox
// (docs/box-request-inbox.md) into AppState.boxRequestInbox (keyed by lowercased
// fqdn → the typed List<BoxRequest>). Every server card, detail page, and the
// post-creation checklist read their per-server state off that one object —
// `unlock-key` and `entitlement` are two `type` values in one inbox, not two
// parallel sets, so a new request type later is one registry entry, no new
// watcher/boolean. Kotlin mirror of iOS BootApprovalWatcher.
//
// DIRECTORY-DRIVEN, NO BIOMETRIC. Detection reads the unauthenticated `/pods`
// directory's cheap `pendingRequests` digest — NOT the IRK-signed mailbox. The
// previous implementation polled SecretRequestCoordinator.fetchVerifiedRequests()
// every 5s, which derives the IRK (a Keystore biometric gate): on a real device
// that fired Face ID on the Home tab every freshness window. Face ID now fires
// ONLY on the actual Approve mutation, never to detect.
//
// Best-effort: the `pollAwaiting` closure swallows failures and returns the
// prior inbox, so a blip never thrashes the UI.

package com.flagshipserver.app.core

class BootApprovalWatcher(
    private val app: AppState,
    /** Refresh the `/pods` directory (unauthenticated, NO biometric) and return
     *  the unified inbox it reports (lowercased fqdn → List<BoxRequest>). */
    private val pollAwaiting: suspend () -> Map<String, List<BoxRequest>>,
) {
    /** One directory refresh → publish the unified Box Request Inbox onto
     *  AppState. Returns the resolved inbox. */
    suspend fun pollOnce(): Map<String, List<BoxRequest>> {
        val inbox = pollAwaiting()
        app.setBoxRequestInbox(inbox)
        return inbox
    }
}
