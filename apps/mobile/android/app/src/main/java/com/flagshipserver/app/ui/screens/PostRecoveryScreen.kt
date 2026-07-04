// Post-recovery confirmation screen. Surfaces the daemon's
// /api/screens/post-recovery/status snapshot — per-app rewrite counts,
// the IRK transition prefixes, and the undo-window deadline.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.PostRecoverySnapshot
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.core.FlagshipDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun PostRecoveryScreen(nav: NavController) {
    val client = LocalScreensClient.current
    var snapshot by remember { mutableStateOf<PostRecoverySnapshot?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            snapshot = client.postRecoveryStatus().report
        } catch (t: Throwable) {
            error = t.message
        }
    }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Post-recovery",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )

        Spacer(Modifier.height(FS.space.s6))

        if (error != null) {
            ErrorCard(message = error!!)
            return@Column
        }

        val snap = snapshot
        if (snap == null) {
            ServerCardSkeleton()
            return@Column
        }

        val report = snap.lastReissue
        if (report == null) {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Text(
                    "No recovery has happened on this pod since boot.",
                    color = FS.colors.textMuted,
                )
            }
            return@Column
        }

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSPill(report.status.uppercase(), kind = when (report.status) {
                    "complete" -> FSPillKind.Online
                    "failed" -> FSPillKind.Offline
                    else -> FSPillKind.Renewing
                })
                Text(
                    "${report.oldIrkPrefix} → ${report.newIrkPrefix}",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                )
                Text(
                    "${report.totalRewritten} rewrites · ${report.reattachedCount} apps reattached · ${report.unchangedCount} unchanged",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
                Text(
                    "Undo window expires ${FlagshipDateFormat.format(report.undoWindowExpiresAt, includeTime = true)}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
            }
        }

        Spacer(Modifier.height(FS.space.s4))
        Text(
            "Per-app",
            color = FS.colors.text,
            style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.height(FS.space.s2))
        report.apps.forEach { app ->
            FSCard(padding = PaddingValues(FS.space.s3)) {
                Column {
                    Text(app.slug, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium))
                    Text(
                        "${app.rewrittenCount} rewrites · ${app.unchangedCount} unchanged",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                    )
                    if (app.error != null) {
                        Text("error: ${app.error}", color = FS.colors.danger, style = TextStyle(fontSize = 12.sp))
                    }
                }
            }
            Spacer(Modifier.height(FS.space.s2))
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}
