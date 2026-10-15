// Keeps the app's glanceable surfaces in step with AppState: whenever the
// account, its servers or the leader change, the server-status snapshot is
// rewritten, the home-screen widget redrawn and the launcher shortcuts
// refreshed. Hosted once at the app root
// (MainActivity), the Android twin of iOS's PodStatusPublisher.

package com.flagshipserver.app.companion

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.companion.PodStatusSnapshot

@Composable
fun CompanionSurfaces(app: AppState) {
    val context = LocalContext.current.applicationContext
    val paired by app.isPaired.collectAsState()
    val user by app.currentUser.collectAsState()
    val pods by app.orderedPods.collectAsState()
    val leader by app.leaderPodId.collectAsState()
    LaunchedEffect(paired, user, pods, leader) {
        val snapshot = PodStatusStore.snapshot(paired, user, pods, leader, Endpoints.controlHost)
        CompanionPublisher.publishStatus(context, snapshot)
    }
}

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
