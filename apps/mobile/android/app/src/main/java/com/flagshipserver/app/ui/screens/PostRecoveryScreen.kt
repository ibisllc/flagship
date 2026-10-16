// Post-recovery confirmation screen. Surfaces the daemon's
// /api/screens/post-recovery/status snapshot — per-app rewrite counts,
// the IRK transition prefixes, and the undo-window deadline.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.flagshipserver.app.api.PostRecoverySnapshot
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.plural
import com.flagshipserver.app.ui.theme.FS

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

    FSScreen(
        title = "Re-attach progress",
        onBack = { nav.popBackStack() },
        subtitle = "After a re-pair, your servers re-anchor every app's membership to your new identity. This screen shows what they've finished.",
    ) {
        val snap = snapshot
        val report = snap?.lastReissue
        when {
            error != null -> ErrorCard(message = error!!)
            snap == null -> ServerCardSkeleton()
            report == null -> FSEmptyState(
                title = "No recovery in progress.",
                message = "No recovery has happened on this server since it started.",
                icon = Icons.Outlined.CheckCircle,
                iconTint = FS.colors.success,
            )
            else -> {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSSectionHeader("Status")
                    FSCard {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            FSPill(
                                report.status.replaceFirstChar { it.uppercase() },
                                kind = when (report.status) {
                                    "complete" -> FSPillKind.Online
                                    "failed" -> FSPillKind.Offline
                                    else -> FSPillKind.Renewing
                                },
                            )
                            Text(
                                "Re-anchored ${plural(report.totalRewritten, "membership row")} across ${plural(report.reattachedCount, "app")}.",
                                style = MaterialTheme.typography.bodyLarge,
                            )
                            Text(
                                "${report.oldIrkPrefix} → ${report.newIrkPrefix} · ${report.unchangedCount} unchanged",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }

                if (report.apps.isNotEmpty()) {
                    FSGroup(header = "Per-app results") {
                        report.apps.forEachIndexed { idx, app ->
                            val failed = app.error != null
                            FSRow(
                                title = app.slug,
                                subtitle = app.error
                                    ?: "${plural(app.rewrittenCount, "row")} re-anchored · ${app.unchangedCount} unchanged",
                                icon = if (failed) Icons.Outlined.WarningAmber else Icons.Outlined.CheckCircle,
                                iconTint = if (failed) FS.colors.danger else FS.colors.success,
                            )
                            if (idx < report.apps.size - 1) FSDivider()
                        }
                    }
                }

                FSCard {
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3), verticalAlignment = Alignment.Top) {
                        Icon(Icons.Outlined.Info, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(24.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("Undo window", style = MaterialTheme.typography.titleSmall)
                            Text(
                                "If anything looks wrong, you can undo this re-anchoring until ${FlagshipDateFormat.format(report.undoWindowExpiresAt, includeTime = true)}. After that the old identity stops being recoverable.",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
            }
        }
    }
}
