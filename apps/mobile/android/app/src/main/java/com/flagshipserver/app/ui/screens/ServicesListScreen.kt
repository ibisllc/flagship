package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.viewmodels.AppAccessViewModel
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.AppLinksResponse
import com.flagshipserver.app.core.AppStatus
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalPodClients
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSChipItem
import com.flagshipserver.app.ui.components.FSChipRow
import com.flagshipserver.app.ui.components.FSListLeading
import com.flagshipserver.app.ui.components.FSListRow
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.pillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSearchField
import com.flagshipserver.app.ui.components.PodSwitcher
import com.flagshipserver.app.ui.components.PodSwitcherModel
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.flagshipserver.app.viewmodels.ServicesListViewModel
import com.flagshipserver.app.viewmodels.LoadingState

/**
 * Services list — every service the user has installed across all their
 * pods. Tap a row to open the detail screen (where to run,
 * let-instances-talk, URL claims).
 *
 * Restyled to mirror iOS `FlagshipUI/Shell/ServicesTab.swift`: a large
 * "Apps" title, an [FSSearchField] over the list, an All / Yours / Shared
 * [FSChipRow] (shown only when shared apps exist), and one [FSListRow] per
 * app (status-tinted icon, name, summary-or-"by <creator>" subtitle,
 * monospaced short URL, the status pill combining every server the app is
 * on (docs/app-placement.md §6) + chevron). The per-row copy-URL affordance
 * moved to the detail screen.
 */

/** Presentation-only creator filter (mirrors iOS AppsOwnerFilter). */
private enum class OwnerFilter(val label: String) { ALL("All"), YOURS("Yours"), SHARED("Shared") }

@Composable
fun ServicesListScreen(nav: NavController) {
    val screens = LocalScreensClient.current
    val server = LocalFlagshipServerClient.current
    val appState = LocalAppState.current
    val podClients = LocalPodClients.current
    val vm = remember(podClients, screens) {
        ServicesListViewModel(
            client = screens,
            server = server,
            username = { appState.currentUser.value },
            pods = { appState.pods.value },
            // Each server over its own session, as Runs on does; the current
            // server falls back to the screen's own client.
            clientFor = { pod -> podClients.screens(pod) ?: screens.takeIf { pod.podId == appState.currentPod?.podId } },
            preferredPodId = { appState.currentPod?.podId },
        )
    }
    val state by vm.state.collectAsState()
    val linksByServiceId by vm.linksByServiceId.collectAsState()

    // Presentation-only narrowing — never mutates the loaded apps.
    var query by remember { mutableStateOf("") }
    var ownerFilter by remember { mutableStateOf(OwnerFilter.ALL) }
    // V8 — server filter (the PodSwitcher). null == "All servers".
    var serverFilter by remember { mutableStateOf<String?>(null) }

    val me = (appState.currentUser.collectAsState().value ?: "").lowercase()
    val pods by appState.pods.collectAsState()
    val leaderPodId by appState.leaderPodId.collectAsState()
    LaunchedEffect(vm, pods.map { it.podId to it.status }) { vm.refresh() }
    // A pod the user no longer owns can't stay selected (it would hide every
    // app); treat a stale selection as "All servers". Derived (not a state
    // write) so it's safe to compute during composition.
    val effectiveServerFilter = serverFilter?.takeIf { id -> pods.any { it.podId == id } }
    val filterPodName = pods.firstOrNull { it.podId == effectiveServerFilter }?.name

    // Merge the servers' apps lists with the per-service /links fan-out
    // as iOS AppsTab.AppRow does: slug.capitalized name, the combined
    // status pill, short link.
    val allApps: List<AppSummary> = when (val s = state) {
        is LoadingState.Loaded -> s.value.map { toRow(it, linksByServiceId[it.app.serviceId]) }
        else -> emptyList()
    }

    val hasShared = allApps.any { me.isNotEmpty() && it.creator.lowercase() != me }

    val apps: List<AppSummary> = allApps
        .filter { app ->
            val q = query.trim().lowercase()
            q.isEmpty() ||
                app.name.lowercase().contains(q) ||
                (app.summary?.lowercase()?.contains(q) == true) ||
                app.creator.lowercase().contains(q) ||
                (app.shortUrl?.lowercase()?.contains(q) == true)
        }
        .filter { app ->
            when (ownerFilter) {
                OwnerFilter.ALL -> true
                OwnerFilter.YOURS -> me.isEmpty() || app.creator.lowercase() == me
                OwnerFilter.SHARED -> me.isNotEmpty() && app.creator.lowercase() != me
            }
        }
        // V8 — server filter: when a pod is selected, keep the apps that
        // server lists; without per-server answers, the apps whose canonical
        // URL carries that pod's name as a subdomain (mirrors iOS).
        .filter { app ->
            filterPodName == null ||
                (if (app.podIds.isNotEmpty()) effectiveServerFilter in app.podIds
                else PodSwitcherModel.matchesPod(app.canonicalUrl, filterPodName))
        }

    val subtitle = when (val st = state) {
        is LoadingState.Loading -> "Loading…"
        is LoadingState.Failed -> st.message
        else -> if (allApps.isEmpty()) "Nothing installed yet." else "${allApps.size} installed"
    }

    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      // Reading column — clamp + center on expanded panes; a no-op on phones.
      Column(
        modifier = Modifier
            .widthIn(max = FSLayout.readingMaxWidth)
            .fillMaxWidth()
            .padding(horizontal = FS.space.s6),
      ) {
        Spacer(Modifier.height(FS.space.s10))
        Text(
            text = "Services",
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
            modifier = Modifier.testTag("services-title"),
        )
        Text(
            text = subtitle,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        )

        if (allApps.isEmpty() && state !is LoadingState.Loading) {
            Spacer(Modifier.height(FS.space.s8))
            FSCard(padding = PaddingValues(FS.space.s6)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text(
                        text = "Build your first service",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Text(
                        text = "Describe what you want in plain English. The AI writes it; your server runs it.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
                    )
                    FSPrimaryButton(
                        label = "Build a service",
                        onClick = { nav.navigate("build/source") },
                        block = true,
                        modifier = Modifier.testTag("services-build-cta"),
                    )
                }
            }
        } else {
            Spacer(Modifier.height(FS.space.s4))
            // V8 — the server filter sits above search when the user owns more
            // than one pod, doubling as a context switcher ("All servers" =
            // every app regardless of which pod runs it).
            if (pods.size > 1) {
                PodSwitcher(
                    pods = pods,
                    currentPodId = effectiveServerFilter,
                    leaderPodId = leaderPodId,
                    onPick = { serverFilter = it.podId },
                    allLabel = "All servers",
                    onPickAll = { serverFilter = null },
                )
                Spacer(Modifier.height(FS.space.s3))
            }
            FSSearchField(
                value = query,
                onValueChange = { query = it },
                placeholder = "Search services",
            )
            // The owner chips only when there's a meaningful split (at least
            // one shared app), so a solo user isn't given a redundant toggle.
            if (hasShared) {
                Spacer(Modifier.height(FS.space.s3))
                FSChipRow(
                    items = listOf(
                        FSChipItem(OwnerFilter.ALL, OwnerFilter.ALL.label),
                        FSChipItem(OwnerFilter.YOURS, OwnerFilter.YOURS.label),
                        FSChipItem(OwnerFilter.SHARED, OwnerFilter.SHARED.label),
                    ),
                    selection = ownerFilter,
                    onSelect = { ownerFilter = it },
                )
            }
            Spacer(Modifier.height(FS.space.s4))
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                apps.forEach { app ->
                    AppRow(app, me = me, onClick = { nav.navigate("app-detail/${app.serviceId}") })
                }
                BuildAnotherAppRow(onClick = { nav.navigate("build/source") })
            }
        }
      }
    }
}

@Composable
private fun AppRow(app: AppSummary, me: String, onClick: () -> Unit) {
    val running = app.pill.tone == AppStatus.Tone.Online
    val isShared = me.isNotEmpty() && app.creator.lowercase() != me
    FSListRow(
        leading = FSListLeading.Icon(
            icon = if (running) Icons.Outlined.PlayArrow else Icons.Outlined.Stop,
            color = if (running) FS.colors.success else FS.colors.textMuted,
        ),
        title = app.name,
        subtitle = subtitleFor(app, isShared),
        detail = shortUrlText(app),
        onClick = onClick,
    ) {
        if (app.egressPending) {
            FSPill(
                label = AppAccessViewModel.BADGE,
                kind = FSPillKind.Pending,
                modifier = Modifier.testTag("services-row-egress-badge"),
            )
        }
        FSPill(
            label = app.pill.label,
            kind = app.pill.tone.pillKind(),
            modifier = Modifier.testTag("services-row-status"),
        )
        Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
    }
}

/** A dashed-outline "Build another service" affordance under the list. */
@Composable
private fun BuildAnotherAppRow(onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.md))
            .background(FS.colors.primary.copy(alpha = 0.08f))
            .border(1.dp, FS.colors.primary.copy(alpha = 0.25f), RoundedCornerShape(FS.radius.md))
            .clickable(onClick = onClick)
            .padding(horizontal = FS.space.s4, vertical = FS.space.s3)
            .testTag("services-build-cta"),
    ) {
        Icon(Icons.Outlined.Add, contentDescription = null, tint = FS.colors.primary, modifier = Modifier.size(16.dp))
        Text(
            text = "Build another service",
            color = FS.colors.primary,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.weight(1f))
    }
}

/** Subtitle = the app's own summary if present, else a "by <creator>"
 *  attribution for a shared app, else a version hint. Mirrors iOS. */
private fun subtitleFor(app: AppSummary, isShared: Boolean): String? {
    if (!app.summary.isNullOrEmpty()) return app.summary
    if (isShared) return "by ${app.creator}"
    if (!app.version.isNullOrEmpty()) return "v${app.version}"
    return null
}

/** The short (shareable) URL for the monospaced detail line, falling back
 *  to the canonical URL. Mirrors iOS. */
private fun shortUrlText(app: AppSummary): String? {
    val short = app.shortUrl ?: app.canonicalUrl ?: return null
    return stripScheme(short)
}

private fun stripScheme(s: String): String =
    s.removePrefix("https://").removePrefix("http://")

/** Merge one daemon AppSummary + its /links result into the row
 *  display model — faithful to iOS AppsTab.AppRow:
 *  `slug.capitalized` name, status→pill, links.canonicalUrl ?? the
 *  daemon URL. */
private fun toRow(listed: ServicesListViewModel.Listed, links: AppLinksResponse?): AppSummary {
    val api = listed.app
    return AppSummary(
        serviceId = api.serviceId,
        name = api.slug.replaceFirstChar { it.uppercase() },
        creator = api.creator,
        pill = listed.pill,
        podIds = listed.podIds,
        summary = api.summary,
        version = api.version,
        shortUrl = links?.shortUrl,
        canonicalUrl = links?.canonicalUrl ?: api.url,
        egressPending = listed.egressPending,
    )
}

data class AppSummary(
    val serviceId: String,
    val name: String,
    /** Authoring username — drives the "by <creator>" subtitle + Yours/Shared filter. */
    val creator: String = "",
    /** The pill over every server the app is on (status-tinted icon too). */
    val pill: AppStatus.Pill,
    /** The servers that list it (empty when only the current server was asked). */
    val podIds: List<String> = emptyList(),
    /** Optional one-liner description shown under the name. */
    val summary: String? = null,
    /** Optional version hint, used as a subtitle fallback. */
    val version: String? = null,
    /** V3 — voi.ci short URL surfaced to the row. Null while the
     *  /links fan-out is in flight; the row renders no detail line
     *  until a URL is known. */
    val shortUrl: String? = null,
    /** V3 — canonical FQDN; the monospaced detail fallback. */
    val canonicalUrl: String? = null,
    /** A host is waiting for the owner's answer (or, on an older box, the
     *  app declares hosts the owner hasn't allowed yet). */
    val egressPending: Boolean = false,
)
