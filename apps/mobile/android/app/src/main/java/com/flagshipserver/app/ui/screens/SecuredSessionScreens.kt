// Web-experience gating Settings surfaces (docs/service-access-gating.md):
//   • "Open secured sessions" — the browser QR-logins this phone authorized,
//     each with a Refresh (online/offline, ≥60s debounce) + Stop.
//   • "Process URL" — paste a flagship://access link / "Get link" string and
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
import com.flagshipserver.app.ui.components.FSField
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

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(FS.space.s4),
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Text(
            "Secured sessions",
            color = FS.colors.text,
            style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
            modifier = Modifier.testTag("secured-sessions-title"),
        )
        Text(
            "Browser sessions you authorized for restricted sites. Stop one to log that browser out.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 19.sp),
        )

        if (rows.isEmpty()) {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Text(
                    "No secured sessions yet. Scan a restricted site's QR with this app to authorize one.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp),
                    modifier = Modifier.testTag("secured-sessions-empty"),
                )
            }
        } else {
            rows.forEach { row ->
                SecuredSessionCard(
                    row = row,
                    onRefresh = { scope.launch { vm.refresh(row.session.secretId) } },
                    onStop = { scope.launch { vm.stop(row.session.secretId) } },
                )
            }
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun SecuredSessionCard(
    row: SecuredSessionRow,
    onRefresh: () -> Unit,
    onStop: () -> Unit,
) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                row.session.serviceUrl,
                color = FS.colors.text,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
                modifier = Modifier.testTag("secured-session-url"),
            )
            row.session.browserAgent.takeIf { it.isNotBlank() }?.let {
                Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, lineHeight = 17.sp))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    livenessLabel(row.liveness, row.refreshing),
                    color = livenessColor(row.liveness),
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
                    modifier = Modifier.testTag("secured-session-status"),
                )
                Text(
                    "· started ${formatTs(row.session.startedAt)}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
            }
            Spacer(Modifier.height(FS.space.s1))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FSGhostButton(
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
    SessionLiveness.ONLINE -> FS.colors.primary
    SessionLiveness.OFFLINE -> FS.colors.textMuted
    SessionLiveness.UNKNOWN -> FS.colors.textMuted
}

private fun formatTs(ms: Long): String =
    if (ms <= 0) "—" else FlagshipDateFormat.format(ms, includeTime = true)

/**
 * "Process URL" — paste a flagship://access link / "Get link" string and run
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

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(FS.space.s4),
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Text(
            "Process a link",
            color = FS.colors.text,
            style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
            modifier = Modifier.testTag("process-url-title"),
        )
        Text(
            "Paste a Flagship link — a restricted site's \"Get link\" string, or a " +
                "\"take over this box\" transfer link someone shared with you.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 19.sp),
        )
        FSField(
            value = text,
            onValueChange = { text = it; error = null },
            label = "Link",
            placeholder = "flagship://…",
            fieldTag = "process-url-input",
        )
        error?.let {
            Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp), modifier = Modifier.testTag("process-url-error"))
        }
        FSPrimaryButton(
            label = "Open",
            block = true,
            large = true,
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
                    else -> error = "That doesn't look like a Flagship link."
                }
            },
            modifier = Modifier.testTag("process-url-submit"),
        )
        Spacer(Modifier.height(FS.space.s12))
    }
}

/** Parse a pasted string into an AuthorizeKnock, or null. Extracted for tests. */
fun parseAccessLink(raw: String): DeepLink.AuthorizeKnock? =
    (runCatching { DeepLink.parse(Uri.parse(raw)) }.getOrNull()) as? DeepLink.AuthorizeKnock
