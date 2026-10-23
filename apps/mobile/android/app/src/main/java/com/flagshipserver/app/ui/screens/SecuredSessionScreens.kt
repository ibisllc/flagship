// Web-experience gating Settings surfaces (docs/service-access-gating.md):
//   • "Open secured sessions" — the browser QR-logins this phone authorized,
//     each with a Refresh (online/offline, ≥60s debounce) + Stop.
//   • "Process URL" — paste an /access link / "Get link" string and
//     run the same authorize flow as the deep link (for when the QR can't be
//     scanned cross-device, or the link was copied).

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavController
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.SecuredSessionRow
import com.flagshipserver.app.viewmodels.SecuredSessionsViewModel
import com.flagshipserver.app.viewmodels.SessionLiveness
import kotlinx.coroutines.launch
import com.flagshipserver.app.core.FlagshipDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun SecuredSessionsScreen(
    nav: NavController,
    vm: SecuredSessionsViewModel = viewModel(),
) {
    val rows by vm.rows.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { vm.reload() }

    FSScreen(
        title = stringResource(R.string.secured_sessions),
        onBack = { nav.popBackStack() },
        titleTag = "secured-sessions-title",
        subtitle = stringResource(R.string.browsers_you_signed_in_to_private),
        onRefresh = { vm.reload() },
    ) {
        if (rows.isEmpty()) {
            FSEmptyState(
                title = stringResource(R.string.no_open_sessions),
                message = stringResource(R.string.scan_a_private_apps_sign_in),
                icon = Icons.Outlined.Laptop,
                modifier = Modifier.testTag("secured-sessions-empty"),
            )
        } else {
            rows.forEach { row ->
                SecuredSessionCard(
                    row = row,
                    onRefresh = { scope.launch { vm.refresh(row.session.secretId) } },
                    onStop = { scope.launch { vm.stop(row.session.secretId) } },
                )
            }
        }
    }
}

@Composable
private fun SecuredSessionCard(
    row: SecuredSessionRow,
    onRefresh: () -> Unit,
    onStop: () -> Unit,
) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                row.session.serviceUrl,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.testTag("secured-session-url"),
            )
            row.session.browserAgent.takeIf { it.isNotBlank() }?.let {
                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    livenessLabel(row.liveness, row.refreshing),
                    color = livenessColor(row.liveness),
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.testTag("secured-session-status"),
                )
                Text(
                    fsString(R.string.started_2, formatTs(row.session.startedAt)),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(top = FS.space.s2),
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FSSecondaryButton(
                    label = if (row.refreshing) stringResource(R.string.checking) else stringResource(R.string.refresh),
                    enabled = !row.refreshing,
                    onClick = onRefresh,
                    modifier = Modifier.testTag("secured-session-refresh"),
                )
                FSDangerButton(
                    label = stringResource(R.string.stop),
                    onClick = onStop,
                    modifier = Modifier.testTag("secured-session-stop"),
                )
            }
        }
    }
}

private fun livenessLabel(l: SessionLiveness, refreshing: Boolean): String = when {
    refreshing -> FSStrings.get(R.string.checking)
    l == SessionLiveness.ONLINE -> FSStrings.get(R.string.online)
    l == SessionLiveness.OFFLINE -> FSStrings.get(R.string.offline)
    else -> FSStrings.get(R.string.tap_refresh_to_check)
}

@Composable
private fun livenessColor(l: SessionLiveness) = when (l) {
    SessionLiveness.ONLINE -> FS.colors.success
    SessionLiveness.OFFLINE -> MaterialTheme.colorScheme.onSurfaceVariant
    SessionLiveness.UNKNOWN -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun formatTs(ms: Long): String =
    if (ms <= 0) "—" else FlagshipDateFormat.format(ms, includeTime = true)

/** Parse a pasted string into an AuthorizeKnock, or null. Extracted for tests. */
fun parseAccessLink(raw: String): DeepLink.AuthorizeKnock? =
    (runCatching { DeepLink.parse(Uri.parse(raw)) }.getOrNull()) as? DeepLink.AuthorizeKnock
