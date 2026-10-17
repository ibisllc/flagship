// Web-experience gating Settings surfaces (docs/service-access-gating.md):
//   • "Open secured sessions" — the browser QR-logins this phone authorized,
//     each with a Refresh (online/offline, ≥60s debounce) + Stop.
//   • "Process URL" — paste an /access link / "Get link" string and
//     run the same authorize flow as the deep link (for when the QR can't be
//     scanned cross-device, or the link was copied).

package com.flagshipserver.app.ui.screens

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
        title = "Secured sessions",
        onBack = { nav.popBackStack() },
        titleTag = "secured-sessions-title",
        subtitle = "Browsers you signed in to private apps. Stop one to sign that browser out.",
        onRefresh = { vm.reload() },
    ) {
        if (rows.isEmpty()) {
            FSEmptyState(
                title = "No open sessions",
                message = "Scan a private app's sign-in QR with this app to sign a browser in.",
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
                    "· started ${formatTs(row.session.startedAt)}",
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
                    label = if (row.refreshing) "Checking…" else "Refresh",
                    enabled = !row.refreshing,
                    onClick = onRefresh,
                    modifier = Modifier.testTag("secured-session-refresh"),
                )
                FSDangerButton(
                    label = "Stop",
                    onClick = onStop,
                    modifier = Modifier.testTag("secured-session-stop"),
                )
            }
        }
    }
}

private fun livenessLabel(l: SessionLiveness, refreshing: Boolean): String = when {
    refreshing -> "Checking…"
    l == SessionLiveness.ONLINE -> "Online"
    l == SessionLiveness.OFFLINE -> "Offline"
    else -> "Tap Refresh to check"
}

@Composable
private fun livenessColor(l: SessionLiveness) = when (l) {
    SessionLiveness.ONLINE -> FS.colors.success
    SessionLiveness.OFFLINE -> MaterialTheme.colorScheme.onSurfaceVariant
    SessionLiveness.UNKNOWN -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun formatTs(ms: Long): String =
    if (ms <= 0) "—" else FlagshipDateFormat.format(ms, includeTime = true)

/**
 * "Process URL" — paste an https://flagshipserver.com/access link / "Get link" string and run
 * the same authorize flow as the deep link. On a valid link, navigates to the
 * KnockAuthorize screen via the shared route.
 */
@Composable
fun ProcessUrlScreen(nav: NavController) {
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    // Slice C — a pasted transfer take-over link routes through the shared
    // deep-link canal (RootShell steers it to Home → the acquirer flow), the
    // same path the universal link / QR uses.
    val deepLinker = LocalDeepLinker.current

    FSScreen(
        title = "Process a link",
        onBack = { nav.popBackStack() },
        titleTag = "process-url-title",
        subtitle = "Paste a Flagship link: a private app's \"Get link\" string, or a " +
            "\"take over this server\" transfer link someone shared with you.",
    ) {
        FSField(
            value = text,
            onValueChange = { text = it; error = null },
            label = "Link",
            placeholder = "https://${com.flagshipserver.app.core.Endpoints.controlHost}/…",
            fieldTag = "process-url-input",
        )
        error?.let {
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("process-url-error"),
            )
        }
        FSPrimaryButton(
            label = "Open",
            block = true,
            enabled = text.isNotBlank(),
            onClick = {
                when (val link = runCatching { DeepLink.parse(Uri.parse(text.trim())) }.getOrNull()) {
                    is DeepLink.AuthorizeKnock -> {
                        val srv = java.net.URLEncoder.encode(link.serverId, "UTF-8")
                        val svc = java.net.URLEncoder.encode(link.svc, "UTF-8")
                        val ref = java.net.URLEncoder.encode(link.serviceRef, "UTF-8")
                        val pg = java.net.URLEncoder.encode(link.pageId, "UTF-8")
                        nav.navigate("knock-authorize/$srv/$ref/$pg?svc=$svc")
                    }
                    is DeepLink.TransferOffer -> {
                        // Hand off to the shell's deep-link router (→ Home → the
                        // acquirer flow, which verifies the offer before claiming).
                        deepLinker.enqueue(link)
                    }
                    is DeepLink.ShareOffer -> deepLinker.enqueue(link)
                    // A remote page's code: Settings → Remote approves it.
                    is DeepLink.CompanionDockApproval -> deepLinker.enqueue(link)
                    is DeepLink.BuilderPair -> deepLinker.enqueue(link)
                    is DeepLink.AcceptInvite -> deepLinker.enqueue(link)
                    is DeepLink.RedeemInvite -> deepLinker.enqueue(link)
                    else -> error = "That doesn't look like a Flagship link."
                }
            },
            modifier = Modifier.testTag("process-url-submit"),
        )
    }
}

/** Parse a pasted string into an AuthorizeKnock, or null. Extracted for tests. */
fun parseAccessLink(raw: String): DeepLink.AuthorizeKnock? =
    (runCatching { DeepLink.parse(Uri.parse(raw)) }.getOrNull()) as? DeepLink.AuthorizeKnock
