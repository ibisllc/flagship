// Home-screen widget showing each server's online state, the twin of iOS's
// PodStatusWidget: the small size shows the leader (name, address, state),
// the wide size lists up to four servers with a Leader badge. A tap opens that
// server's page in the app. It renders the snapshot the app wrote
// (PodStatusStore) and never fetches.

package com.flagshipserver.app.companion

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.flagshipserver.app.MainActivity
import com.flagshipserver.companion.PodStatusSnapshot
import com.flagshipserver.companion.PodStatusText

class PodStatusWidget : GlanceAppWidget() {

    override val sizeMode = SizeMode.Responsive(setOf(SMALL, WIDE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snapshot = PodStatusStore.from(context).read()
        provideContent {
            GlanceTheme { PodStatusContent(context, snapshot) }
        }
    }

    companion object {
        val SMALL = DpSize(110.dp, 110.dp)
        val WIDE = DpSize(250.dp, 110.dp)

        /** Re-render every placed widget from the stored snapshot. */
        suspend fun refresh(context: Context) {
            runCatching { PodStatusWidget().updateAll(context) }
        }

        /** The activity intent that opens [url] (an in-app link) in the app. */
        fun openIntent(context: Context, url: String?): Intent =
            Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                if (url != null) data = Uri.parse(url)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
    }
}

class PodStatusWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PodStatusWidget()
}

@Composable
private fun PodStatusContent(context: Context, snapshot: PodStatusSnapshot) {
    val open: (PodStatusSnapshot.Pod?) -> Action = { pod ->
        actionStartActivity(PodStatusWidget.openIntent(context, pod?.let(snapshot::serverUrl)))
    }
    val base = GlanceModifier
        .fillMaxSize()
        .background(GlanceTheme.colors.widgetBackground)
        .cornerRadius(16.dp)
        .padding(12.dp)
    val headline = snapshot.headline
    when {
        headline == null -> EmptyState(base.clickable(open(null)))
        LocalSize.current.width >= PodStatusWidget.WIDE.width -> Column(modifier = base) {
            snapshot.listed().forEach { pod ->
                Row(
                    modifier = GlanceModifier.fillMaxWidth().padding(vertical = 3.dp).clickable(open(pod)),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StatusDot(pod.statusRaw)
                    Spacer(GlanceModifier.width(8.dp))
                    Text(
                        pod.name,
                        style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp, fontWeight = FontWeight.Medium),
                        maxLines = 1,
                    )
                    if (pod.isLeader) {
                        Spacer(GlanceModifier.width(6.dp))
                        LeaderBadge()
                    }
                    Spacer(GlanceModifier.defaultWeight())
                    Text(
                        PodStatusText.label(pod.statusRaw).uppercase(),
                        style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp),
                    )
                }
            }
        }
        else -> Column(modifier = base.clickable(open(headline))) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(headline.statusRaw)
                Spacer(GlanceModifier.width(6.dp))
                Text(
                    headline.name,
                    style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    maxLines = 1,
                )
            }
            Spacer(GlanceModifier.height(6.dp))
            Text(
                headline.fqdn,
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                ),
                maxLines = 2,
            )
            Spacer(GlanceModifier.defaultWeight())
            Text(
                PodStatusText.label(headline.statusRaw).uppercase(),
                style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp),
            )
        }
    }
}

@Composable
private fun EmptyState(modifier: GlanceModifier) {
    Column(modifier = modifier) {
        Text(
            FSStrings.get(R.string.no_servers_yet),
            style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 15.sp, fontWeight = FontWeight.Bold),
        )
        Spacer(GlanceModifier.height(4.dp))
        Text(
            FSStrings.get(R.string.pair_a_server_to_see_status),
            style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp),
        )
    }
}

@Composable
private fun LeaderBadge() {
    Box(
        modifier = GlanceModifier
            .background(GlanceTheme.colors.primaryContainer)
            .cornerRadius(8.dp)
            .padding(horizontal = 4.dp, vertical = 1.dp),
    ) {
        Text(
            FSStrings.get(R.string.leader),
            style = TextStyle(color = GlanceTheme.colors.onPrimaryContainer, fontSize = 9.sp, fontWeight = FontWeight.Bold),
        )
    }
}

@Composable
private fun StatusDot(statusRaw: String) {
    // The app's status tokens (Tokens.kt), following the launcher's theme.
    val tone = PodStatusText.tone(statusRaw)
    val color = androidx.glance.color.ColorProvider(
        day = Color(com.flagshipserver.companion.StatusPalette.light(tone)),
        night = Color(com.flagshipserver.companion.StatusPalette.dark(tone)),
    )
    Box(modifier = GlanceModifier.size(8.dp).cornerRadius(4.dp).background(color)) {}
}
