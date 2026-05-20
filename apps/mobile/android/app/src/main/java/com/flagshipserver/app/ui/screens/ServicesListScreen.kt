package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.AppLinksResponse
import com.flagshipserver.app.api.AppSummary as ApiAppSummary
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ServicesListViewModel
import com.flagshipserver.app.viewmodels.LoadingState

/**
 * Services list — every service the user has installed across all their
 * pods. Tap a row to open the detail screen (where to run,
 * let-instances-talk, URL claims).
 */
@Composable
fun ServicesListScreen(nav: NavController) {
    val screens = LocalScreensClient.current
    val server = LocalFlagshipServerClient.current
    val appState = LocalAppState.current
    val vm = remember {
        ServicesListViewModel(
            client = screens,
            server = server,
            username = { appState.currentUser.value },
        )
    }
    val state by vm.state.collectAsState()
    val linksByServiceId by vm.linksByServiceId.collectAsState()
    LaunchedEffect(Unit) { vm.load() }

    // Merge the daemon apps-list with the per-service /links fan-out
    // exactly as iOS AppsTab.AppRow does: slug.capitalized name,
    // status pill, confirmed-custom-domain → short-link swap.
    val apps: List<AppSummary> = when (val s = state) {
        is LoadingState.Loaded -> s.value.map { toRow(it, linksByServiceId[it.serviceId]) }
        else -> emptyList()
    }
    val subtitle = when (val st = state) {
        is LoadingState.Loading -> "Loading…"
        is LoadingState.Failed -> st.message
        else -> if (apps.isEmpty()) "Nothing installed yet." else "${apps.size} installed"
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s10))
        Text(
            text = "Apps",
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = subtitle,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        )
        Spacer(Modifier.height(FS.space.s8))

        if (apps.isEmpty() && state !is LoadingState.Loading) {
            FSCard(padding = PaddingValues(FS.space.s6)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text(
                        text = "Build your first app",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Text(
                        text = "Describe what you want in plain English. The AI writes it; the daemon runs it.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
                    )
                    FSPrimaryButton(
                        label = "Vibe-code an app",
                        onClick = { nav.navigate("vibe/describe") },
                        block = true,
                    )
                    FSGhostButton(
                        label = "Browse marketplace",
                        onClick = { nav.navigate("marketplace") },
                        block = true,
                    )
                }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                apps.forEach { app ->
                    AppRow(app, onClick = { nav.navigate("app-detail/${app.serviceId}") })
                }
            }
        }
    }
}

@Composable
private fun AppRow(app: AppSummary, onClick: () -> Unit) {
    val ctx = LocalContext.current
    FSCard(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        padding = PaddingValues(FS.space.s4),
    ) {
        Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            // Name (semibold).
            Text(
                text = app.name,
                color = FS.colors.text,
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
            )
            // Short description (if any).
            if (!app.summary.isNullOrEmpty()) {
                Text(
                    text = app.summary,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    maxLines = 2,
                )
            }
            // Status pills.
            Row(
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FSPill(
                    label = if (app.runningPodCount > 0) "Running on ${app.runningPodCount}" else "Stopped",
                    kind = if (app.runningPodCount > 0) FSPillKind.Online else FSPillKind.Idle,
                )
                if (app.siblingsEnabled) {
                    FSPill(label = "Siblings on", kind = FSPillKind.Provisioning)
                }
            }
            // V7 — short link on its own line (semibold, no icon) with
            // a copy control; canonical BELOW it, full-width, single-
            // line truncate. The section the row sits in already says
            // what these are, so no leading glyphs.
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // A bound custom domain takes the short link's slot
                    // ONLY once .com has confirmed it — that swap is
                    // the subtle "it's live" cue. Mirrors iOS
                    // AppsTab.urlRow + the webapp apps-list.
                    val short = if (app.customDomainConfirmed == true && !app.customDomain.isNullOrEmpty()) {
                        "https://${app.customDomain}"
                    } else {
                        app.shortUrl
                    }
                    if (!short.isNullOrEmpty()) {
                        Text(
                            text = stripScheme(short),
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                            maxLines = 1,
                            modifier = Modifier.padding(end = FS.space.s2),
                        )
                        FSGhostButton(label = "Copy", onClick = { copyToClipboard(ctx, short) })
                    } else {
                        Text(
                            text = "voi.ci/…",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 12.sp),
                        )
                    }
                    Spacer(Modifier.weight(1f))
                }
                if (!app.canonicalUrl.isNullOrEmpty()) {
                    Text(
                        text = stripScheme(app.canonicalUrl),
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 11.sp),
                        maxLines = 1,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

private fun stripScheme(s: String): String =
    s.removePrefix("https://").removePrefix("http://")

private fun copyToClipboard(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    cm?.setPrimaryClip(ClipData.newPlainText("flagship", text))
}

/** Merge one daemon AppSummary + its /links result into the row
 *  display model — faithful to iOS AppsTab.AppRow:
 *  `slug.capitalized` name, status→pill, links.canonicalUrl ?? the
 *  daemon URL, and the confirmed-custom-domain short-link swap (the
 *  swap itself lives in AppRow, gated on customDomainConfirmed). */
private fun toRow(api: ApiAppSummary, links: AppLinksResponse?): AppSummary =
    AppSummary(
        serviceId = api.serviceId,
        name = api.slug.replaceFirstChar { it.uppercase() },
        runningPodCount = if (api.status == "running") 1 else 0,
        siblingsEnabled = false,
        summary = api.summary,
        shortUrl = links?.shortUrl,
        canonicalUrl = links?.canonicalUrl ?: api.url,
        customDomain = links?.customDomain,
        customDomainConfirmed = links?.customDomainConfirmed,
    )

data class AppSummary(
    val serviceId: String,
    val name: String,
    val runningPodCount: Int,
    val siblingsEnabled: Boolean,
    /** Optional one-liner description shown under the name. */
    val summary: String? = null,
    /** V3 — voi.ci short URL surfaced to the row. Null while the
     *  /links fan-out is in flight; the row renders a 'voi.ci/…'
     *  placeholder so the vertical rhythm stays stable. */
    val shortUrl: String? = null,
    /** V3 — canonical FQDN; muted right-aligned text in the URL row. */
    val canonicalUrl: String? = null,
    /** #81 — the bound external domain + whether .com confirmed it.
     *  Populated by the same /links fan-out as shortUrl. */
    val customDomain: String? = null,
    val customDomainConfirmed: Boolean? = null,
)
