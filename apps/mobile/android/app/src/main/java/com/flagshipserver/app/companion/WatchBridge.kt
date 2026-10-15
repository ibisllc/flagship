// Phone side of the Wear OS companion, the twin of iOS's WatchBridge. It
// publishes one WatchContext data item (servers, boxes waiting for a boot
// approval, recent security events, an install in flight) that the watch
// reads, and holds the responder that answers the watch's Approve.
//
// Best-effort throughout: without a paired watch (or Google Play services'
// Wearable API) a publish just fails quietly.

package com.flagshipserver.app.companion

import android.content.Context
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.WatchApprovalResponder
import com.flagshipserver.companion.PendingApproval
import com.flagshipserver.companion.PodStatusSnapshot
import com.flagshipserver.companion.ProvisionTimeline
import com.flagshipserver.companion.SecurityAlert
import com.flagshipserver.companion.WatchContext
import com.flagshipserver.companion.WatchPaths
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

object WatchBridge {
    @Volatile private var appContext: Context? = null

    /** Answers the watch's Approve; null while no unlocked app holds it. */
    @Volatile var responder: WatchApprovalResponder? = null

    private val lock = Any()
    private var context = WatchContext.EMPTY
    private var lastSent: WatchContext? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Wire the bridge once at app start. */
    fun attach(context: Context) {
        appContext = context.applicationContext
        ProvisionProgressCenter.listener = { _, u -> updateProvision(u) }
    }

    /** The boxes the server list shows waiting for their boot unlock. */
    fun approvalsFrom(pods: List<PodInfo>): List<PendingApproval> =
        pods.filter { it.awaitingUnlock && !it.isRevoked && it.fqdn.isNotEmpty() }
            .map { PendingApproval(requestId = null, serverFqdn = it.fqdn, serverName = it.name) }

    fun updateStatus(status: PodStatusSnapshot, approvals: List<PendingApproval>) = mutate {
        if (status.pods.isEmpty() && status.username == null) WatchContext.EMPTY
        else it.copy(status = status, pendingApprovals = approvals)
    }

    fun publishEvents(events: List<SecurityAlert>) = mutate { it.copy(recentEvents = events) }

    fun updateProvision(u: ProvisionUpdate) = mutate {
        it.copy(
            provision = ProvisionTimeline(
                key = u.key,
                podName = u.podName,
                serverDomain = u.serverDomain,
                phase = u.phase,
                detail = u.detail,
                updatedAt = u.at,
            ),
        )
    }

    /** The context a publish would send now (tests). */
    fun current(): WatchContext = synchronized(lock) { context }

    internal fun resetForTest() = synchronized(lock) {
        context = WatchContext.EMPTY
        lastSent = null
        appContext = null
    }

    private fun mutate(change: (WatchContext) -> WatchContext) {
        val next: WatchContext
        synchronized(lock) {
            next = change(context)
            context = next
            if (lastSent == next) return
            lastSent = next
        }
        val ctx = appContext ?: return
        scope.launch {
            runCatching {
                val req = PutDataMapRequest.create(WatchPaths.CONTEXT).apply {
                    dataMap.putString(WatchPaths.CONTEXT_KEY, next.copy(updatedAt = System.currentTimeMillis()).encode())
                }.asPutDataRequest().setUrgent()
                Wearable.getDataClient(ctx).putDataItem(req).await()
            }
        }
    }
}
