// Post-recovery confirmation screen. Surfaces the daemon's
// /api/screens/post-recovery/status snapshot — per-app rewrite counts,
// the IRK transition prefixes, and the undo-window deadline.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
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

    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(attempt) {
        error = null
        try {
            snapshot = client.postRecoveryStatus().report
        } catch (t: Throwable) {
            error = t.message
        }
    }

    FSScreen(
        title = stringResource(R.string.re_attach_progress),
        onBack = { nav.popBackStack() },
        subtitle = stringResource(R.string.after_a_re_pair_your_servers),
    ) {
        val snap = snapshot
        val report = snap?.lastReissue
        when {
            error != null -> ErrorCard(message = error!!, onRetry = { attempt++ })
            snap == null -> ServerCardSkeleton()
            report == null -> FSEmptyState(
                title = stringResource(R.string.no_recovery_in_progress),
                message = stringResource(R.string.no_recovery_has_happened_on_this),
                icon = Icons.Outlined.CheckCircle,
                iconTint = FS.colors.success,
            )
            else -> {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSSectionHeader(stringResource(R.string.status))
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
                                fsString(R.string.membership_rows_reanchored, report.totalRewritten, report.reattachedCount),
                                style = MaterialTheme.typography.bodyLarge,
                            )
                            Text(
                                fsString(R.string.unchanged, report.oldIrkPrefix, report.newIrkPrefix, report.unchangedCount),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }

                if (report.apps.isNotEmpty()) {
                    FSGroup(header = stringResource(R.string.per_app_results)) {
                        report.apps.forEachIndexed { idx, app ->
                            val failed = app.error != null
                            FSRow(
                                title = app.slug,
                                subtitle = app.error
                                    ?: FSStrings.plural(R.plurals.rows_reanchored_unchanged, app.rewrittenCount, app.rewrittenCount, app.unchangedCount),
                                icon = if (failed) Icons.Outlined.WarningAmber else Icons.Outlined.CheckCircle,
                                iconTint = if (failed) FS.colors.danger else FS.colors.success,
                            )
                            if (idx < report.apps.size - 1) FSDivider()
                        }
                    }
                }

                FSCard {
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3), verticalAlignment = Alignment.Top) {
                        Icon(Icons.Outlined.Info, contentDescription = null, tint = FS.colors.accent, modifier = Modifier.size(24.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(stringResource(R.string.undo_window), style = MaterialTheme.typography.titleSmall)
                            Text(
                                fsString(R.string.if_anything_looks_wrong_you_can, FlagshipDateFormat.format(report.undoWindowExpiresAt, includeTime = true)),
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
