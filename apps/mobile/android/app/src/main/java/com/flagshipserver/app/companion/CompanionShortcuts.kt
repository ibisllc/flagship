// Launcher shortcuts (long-press the app icon), the Android twins of iOS's
// App Shortcuts: "Approvals" opens the boxes waiting for a boot approval
// (iOS "Approve unlock"; the approval itself runs in the app, behind the
// biometric), and one per server opens its page (iOS "Show pod"). iOS's
// spoken "Pod status" has no launcher equivalent; the widget shows it.
// Signed out, there are none.

package com.flagshipserver.app.companion

import com.flagshipserver.app.core.FSStrings
import android.content.Context
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.flagshipserver.app.R
import com.flagshipserver.companion.PodStatusSnapshot

object CompanionShortcuts {
    data class Spec(val id: String, val shortLabel: String, val longLabel: String, val url: String, val isServer: Boolean)

    const val APPROVALS_ID = "approvals"

    /** The shortcuts for [snapshot], most useful first. Launchers show about
     *  four, so the list stops at [max]. */
    fun specs(snapshot: PodStatusSnapshot, max: Int): List<Spec> {
        if (snapshot.pods.isEmpty() || max <= 0) return emptyList()
        val approvals = Spec(
            APPROVALS_ID, "Approvals", FSStrings.get(R.string.approve_a_servers_unlock),
            snapshot.appRouteUrl("secret-requests"), isServer = false,
        )
        val servers = snapshot.pods.map { pod ->
            Spec("server:${pod.podId}", pod.name.take(24), FSStrings.get(R.string.open, pod.name).take(48), snapshot.serverUrl(pod), isServer = true)
        }
        return (listOf(approvals) + servers).take(max)
    }

    fun publish(context: Context, snapshot: PodStatusSnapshot) {
        runCatching {
            val max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context).coerceAtLeast(1)
            val shortcuts = specs(snapshot, minOf(max, 4)).mapIndexed { i, s ->
                ShortcutInfoCompat.Builder(context, s.id)
                    .setShortLabel(s.shortLabel)
                    .setLongLabel(s.longLabel)
                    .setIcon(IconCompat.createWithResource(context, if (s.isServer) R.drawable.ic_shortcut_server else R.drawable.ic_shortcut_unlock))
                    .setIntent(PodStatusWidget.openIntent(context, s.url))
                    .setRank(i)
                    .build()
            }
            ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts)
        }
    }
}
