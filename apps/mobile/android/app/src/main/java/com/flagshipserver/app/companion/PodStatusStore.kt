// Where the app leaves the server-status snapshot for the home-screen widget
// (and, from it, the watch). Android's twin of the iOS App Group key
// `pod-status-snapshot.v1`: the widget renders from this alone and never
// fetches.

package com.flagshipserver.app.companion

import android.content.Context
import android.content.SharedPreferences
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.companion.PodStatusSnapshot

class PodStatusStore(private val prefs: SharedPreferences) {

    fun read(): PodStatusSnapshot = PodStatusSnapshot.decode(prefs.getString(KEY, null))

    fun write(snapshot: PodStatusSnapshot) {
        prefs.edit().putString(KEY, snapshot.encode()).apply()
    }

    companion object {
        private const val PREFS = "flagship.companion"
        const val KEY = "pod-status-snapshot.v1"

        fun from(context: Context): PodStatusStore =
            PodStatusStore(context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE))

        /** The snapshot for the account's servers in the owner's order. Signed
         *  out (or not yet paired) it is empty, so nothing outlives a session. */
        fun snapshot(
            paired: Boolean,
            username: String?,
            pods: List<PodInfo>,
            leaderPodId: String?,
            controlHost: String,
            now: Long = System.currentTimeMillis(),
        ): PodStatusSnapshot {
            if (!paired) return PodStatusSnapshot(updatedAt = now, controlHost = controlHost)
            return PodStatusSnapshot(
                username = username,
                pods = pods.map { p ->
                    PodStatusSnapshot.Pod(
                        podId = p.podId,
                        name = p.name,
                        fqdn = p.fqdn,
                        statusRaw = p.status.name.lowercase(),
                        isLeader = p.podId == leaderPodId,
                    )
                },
                updatedAt = now,
                controlHost = controlHost,
            )
        }
    }
}
