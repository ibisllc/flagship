package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.FlagshipServerClient

/**
 * Cancel a still-pending (never registered) server: release the reserved name
 * (un-pin the routing record so the name frees up), belt-and-braces revoke the
 * install auth-code, then drop the pod locally. A registered server goes
 * through [deleteServer] instead.
 *
 * Mirror of iOS `cancelPendingServer` (HomeTab.swift) + the webapp
 * `deleteDeadServer` — the SAME owner-IRK-signed `ReleaseServerName` →
 * `/api/server/release` path. Distinct from the lost/stolen revoke (this is
 * for a box that never checked in). On a release FAILURE the pod is KEPT (the
 * name is still reserved, so dropping it locally would just hide a name the
 * user can't re-use) with a warning toast.
 */
suspend fun decommissionServer(
    pod: PodInfo,
    app: AppState,
    server: FlagshipServerClient,
    toasts: ToastCenter,
) {
    val username = app.currentUser.value
    if (username == null) {
        app.removePod(pod.podId)
        return
    }
    when (val out = CancelPendingOrder.run(pod, username, server)) {
        is CancelPendingOrder.Outcome.Cancelled -> {
            toasts.success(
                if (out.releasedName) FSStrings.get(R.string.server_deleted_the_name_is_free, pod.name)
                else FSStrings.get(R.string.removed_from_your_servers, pod.name),
            )
            app.removePod(pod.podId)
        }
        // The name is still reserved, so the pod stays; the sentence says why.
        is CancelPendingOrder.Outcome.Failed -> toasts.warning(out.message)
    }
}
