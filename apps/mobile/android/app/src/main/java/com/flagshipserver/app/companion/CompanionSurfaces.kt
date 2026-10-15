// Keeps the app's glanceable surfaces in step with AppState: whenever the
// account, its servers or the leader change, the server-status snapshot is
// rewritten, the home-screen widget redrawn, the launcher shortcuts refreshed
// and the watch told. Hosted once at the app root (MainActivity), the Android
// twin of iOS's PodStatusPublisher + WatchBridge.activate.

package com.flagshipserver.app.companion

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.SecretRequestCoordinator
import com.flagshipserver.app.core.WatchApprovalResponder
import com.flagshipserver.app.core.asWatchApprovalSource
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.SessionIrkAccess
import com.flagshipserver.companion.PodStatusSnapshot

@Composable
fun CompanionSurfaces(app: AppState, mailbox: SecretMailboxClient) {
    val context = LocalContext.current.applicationContext
    val paired by app.isPaired.collectAsState()
    val user by app.currentUser.collectAsState()
    val pods by app.orderedPods.collectAsState()
    val leader by app.leaderPodId.collectAsState()
    DisposableEffect(mailbox) {
        WatchBridge.attach(context)
        WatchBridge.responder = watchResponder(app, mailbox)
        onDispose { WatchBridge.responder = null }
    }
    LaunchedEffect(paired, user, pods, leader) {
        val snapshot = PodStatusStore.snapshot(paired, user, pods, leader, Endpoints.controlHost)
        CompanionPublisher.publishStatus(context, snapshot)
        WatchBridge.updateStatus(snapshot, if (paired) WatchBridge.approvalsFrom(pods) else emptyList())
    }
}

/** The watch's Approve, answered with the phone's own approval: never a
 *  biometric prompt, only while this session is unlocked and Quick approve
 *  is on, signed with the watch-delegate key. */
fun watchResponder(app: AppState, mailbox: SecretMailboxClient): WatchApprovalResponder =
    WatchApprovalResponder(
        delegateEnrolled = { Keystore.hasWatchDelegateKey() },
        hasSessionKey = { app.isUnlocked.value && SessionIrkAccess.isSessionUnlocked() },
        makeSource = {
            val user = app.currentUser.value?.takeIf { it.isNotEmpty() }
            if (user == null || !app.isPaired.value) {
                null
            } else {
                SecretRequestCoordinator(
                    mailbox = mailbox,
                    username = user,
                    irk = SessionIrkAccess(),
                    watchDelegate = { SessionIrkAccess.watchDelegate() },
                ).asWatchApprovalSource()
            }
        },
    )

object CompanionPublisher {
    /** Store [snapshot] and redraw the widget, unless only the timestamp moved
     *  (the live sync re-emits the same servers often). */
    suspend fun publishStatus(context: Context, snapshot: PodStatusSnapshot) {
        val store = PodStatusStore.from(context)
        if (store.read().copy(updatedAt = 0) == snapshot.copy(updatedAt = 0)) return
        store.write(snapshot)
        PodStatusWidget.refresh(context)
        CompanionShortcuts.publish(context, snapshot)
    }
}
